import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";

type NotifiState = {
	enabled: boolean;
};

type TaskStatus = "finished" | "error" | "aborted";

type NotifiConfig = {
	command: string;
	title: string;
	body: string;
	urgency: string;
	appName?: string;
	icon?: string;
	expireTime?: string;
	onErrorOnly: boolean;
	notifyOnAbort: boolean;
	focusAware: boolean;
	bellFallback: boolean;
};

type TmuxLocation = {
	sessionId: string;
	windowId: string;
};

type TmuxClient = {
	pid: number;
	sessionId: string;
	windowId: string;
};

type HyprClient = {
	pid?: number;
	mapped?: boolean;
	hidden?: boolean;
	visible?: boolean;
	workspace?: {
		id?: number;
	};
};

type HyprMonitor = {
	activeWorkspace?: {
		id?: number;
	};
	specialWorkspace?: {
		id?: number;
	};
};

const truthy = (value: string | undefined): boolean => {
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const falsy = (value: string | undefined): boolean => {
	if (!value) return false;
	return ["0", "false", "no", "off"].includes(value.toLowerCase());
};

const env = (name: string, fallback?: string): string | undefined => {
	const value = process.env[name];
	return value && value.trim().length > 0 ? value : fallback;
};

const statusBody = (status: TaskStatus): string => {
	if (status === "finished") return "Task Finished";
	if (status === "aborted") return "Task Aborted";
	return "Task Failed";
};

const getTmuxSessionTitle = async (pi: ExtensionAPI): Promise<string | undefined> => {
	if (!process.env.TMUX) return undefined;

	try {
		const result = await pi.exec("tmux", ["display-message", "-p", "#S"], { timeout: 2000 });
		const session = result.stdout.trim();
		return session || undefined;
	} catch {
		return undefined;
	}
};

const getConfig = async (pi: ExtensionAPI, status: TaskStatus): Promise<NotifiConfig> => {
	const tmuxTitle = await getTmuxSessionTitle(pi);

	return {
		command: env("PI_NOTIFI_COMMAND", "notify-send")!,
		title: env("PI_NOTIFI_TITLE", tmuxTitle ?? "pi")!,
		body: env("PI_NOTIFI_BODY", statusBody(status))!,
		urgency: env("PI_NOTIFI_URGENCY", status === "finished" ? "normal" : "critical")!,
		appName: env("PI_NOTIFI_APP_NAME", "pi"),
		icon: env("PI_NOTIFI_ICON"),
		expireTime: env("PI_NOTIFI_EXPIRE_TIME", "0"),
		onErrorOnly: truthy(process.env.PI_NOTIFI_ON_ERROR_ONLY),
		notifyOnAbort: truthy(process.env.PI_NOTIFI_NOTIFY_ON_ABORT),
		focusAware: !falsy(process.env.PI_NOTIFI_FOCUS_AWARE),
		bellFallback: process.env.PI_NOTIFI_BELL_FALLBACK !== "0",
	};
};

const parseJsonArray = <T>(text: string): T[] | undefined => {
	try {
		const value = JSON.parse(text) as unknown;
		return Array.isArray(value) ? (value as T[]) : undefined;
	} catch {
		return undefined;
	}
};

const getTmuxLocation = async (pi: ExtensionAPI): Promise<TmuxLocation | undefined> => {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return undefined;

	try {
		const result = await pi.exec("tmux", ["display-message", "-p", "-t", pane, "#{session_id}\t#{window_id}"], {
			timeout: 2000,
		});
		const [sessionId, windowId] = result.stdout.trim().split("\t");
		if (!sessionId || !windowId) return undefined;
		return { sessionId, windowId };
	} catch {
		return undefined;
	}
};

const getTmuxClientsForWindow = async (pi: ExtensionAPI, location: TmuxLocation): Promise<TmuxClient[]> => {
	try {
		const result = await pi.exec("tmux", [
			"list-clients",
			"-F",
			"#{client_pid}\t#{session_id}\t#{window_id}",
		], { timeout: 2000 });

		return result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const [pidText, sessionId, windowId] = line.split("\t");
				return { pid: Number(pidText), sessionId, windowId };
			})
			.filter(
				(client) =>
					Number.isInteger(client.pid) &&
					client.pid > 0 &&
					client.sessionId === location.sessionId &&
					client.windowId === location.windowId,
			);
	} catch {
		return [];
	}
};

const getAncestorPids = async (pid: number): Promise<number[]> => {
	const pids: number[] = [];
	let current = pid;

	for (let depth = 0; depth < 64 && current > 1; depth++) {
		pids.push(current);

		try {
			const status = await readFile(`/proc/${current}/status`, "utf8");
			const parent = /^PPid:\s+(\d+)$/m.exec(status)?.[1];
			if (!parent) break;
			current = Number(parent);
		} catch {
			break;
		}
	}

	return pids;
};

const getVisibleHyprWorkspaceIds = (monitors: HyprMonitor[]): Set<number> => {
	const ids = new Set<number>();
	for (const monitor of monitors) {
		if (typeof monitor.activeWorkspace?.id === "number") ids.add(monitor.activeWorkspace.id);
		if (typeof monitor.specialWorkspace?.id === "number" && monitor.specialWorkspace.id !== 0) {
			ids.add(monitor.specialWorkspace.id);
		}
	}
	return ids;
};

const hyprClientIsVisible = (client: HyprClient, visibleWorkspaceIds: Set<number>): boolean => {
	const workspaceId = client.workspace?.id;
	return (
		typeof workspaceId === "number" &&
		visibleWorkspaceIds.has(workspaceId) &&
		client.mapped !== false &&
		client.hidden !== true &&
		client.visible !== false
	);
};

const tmuxClientIsInVisibleHyprWindow = async (pi: ExtensionAPI, tmuxClientPid: number): Promise<boolean> => {
	try {
		const [clientsResult, monitorsResult] = await Promise.all([
			pi.exec("hyprctl", ["clients", "-j"], { timeout: 3000 }),
			pi.exec("hyprctl", ["monitors", "-j"], { timeout: 3000 }),
		]);

		const clients = parseJsonArray<HyprClient>(clientsResult.stdout);
		const monitors = parseJsonArray<HyprMonitor>(monitorsResult.stdout);
		if (!clients || !monitors) return false;

		const visibleWorkspaceIds = getVisibleHyprWorkspaceIds(monitors);
		const ancestorPids = new Set(await getAncestorPids(tmuxClientPid));

		return clients.some(
			(client) =>
				typeof client.pid === "number" &&
				ancestorPids.has(client.pid) &&
				hyprClientIsVisible(client, visibleWorkspaceIds),
		);
	} catch {
		return false;
	}
};

const piTmuxWindowIsVisible = async (pi: ExtensionAPI): Promise<boolean> => {
	const location = await getTmuxLocation(pi);
	if (!location) return false;

	const tmuxClients = await getTmuxClientsForWindow(pi, location);
	if (tmuxClients.length === 0) return false;

	for (const tmuxClient of tmuxClients) {
		if (await tmuxClientIsInVisibleHyprWindow(pi, tmuxClient.pid)) return true;
	}

	return false;
};

const getStatus = (messages: unknown[]): TaskStatus => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; stopReason?: string };
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") return "error";
		if (message.stopReason === "aborted") return "aborted";
		return "finished";
	}
	return "finished";
};

const buildNotifySendArgs = (config: NotifiConfig): string[] => {
	const args: string[] = [];
	if (config.appName) args.push("--app-name", config.appName);
	if (config.urgency) args.push("--urgency", config.urgency);
	if (config.icon) args.push("--icon", config.icon);
	if (config.expireTime) args.push("--expire-time", config.expireTime);
	args.push(config.title, config.body);
	return args;
};

const notify = async (pi: ExtensionAPI, ctx: ExtensionContext, status: TaskStatus) => {
	const config = await getConfig(pi, status);
	if (status === "aborted" && !config.notifyOnAbort) return;
	if (config.onErrorOnly && status === "finished") return;
	if (config.focusAware && (await piTmuxWindowIsVisible(pi))) return;

	try {
		await pi.exec(config.command, buildNotifySendArgs(config), { timeout: 5000 });
	} catch (error) {
		if (config.bellFallback) process.stdout.write("\u0007");
		if (ctx.hasUI) {
			ctx.ui.notify(
				`notifi: ${config.command} failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}
};

export default function (pi: ExtensionAPI) {
	let state: NotifiState = {
		enabled: !truthy(process.env.PI_NOTIFI_DISABLED),
	};

	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			const custom = entry as { type?: string; customType?: string; data?: Partial<NotifiState> };
			if (custom.type === "custom" && custom.customType === "notifi-state" && typeof custom.data?.enabled === "boolean") {
				state.enabled = custom.data.enabled;
			}
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!state.enabled) return;
		// If queued steering/follow-up messages remain, this is not the final idle point yet.
		if (ctx.hasPendingMessages()) return;
		await notify(pi, ctx, getStatus(event.messages as unknown[]));
	});

	pi.registerCommand("notifi", {
		description: "Manage desktop notifications when pi finishes a task: status | test | on/enable | off/disable",
		handler: async (args, ctx) => {
			const subcommand = args.trim().toLowerCase() || "status";
			if (subcommand === "on" || subcommand === "enable") {
				state.enabled = true;
				pi.appendEntry("notifi-state", { enabled: true });
				ctx.ui.notify("notifi enabled", "info");
				return;
			}

			if (subcommand === "off" || subcommand === "disable") {
				state.enabled = false;
				pi.appendEntry("notifi-state", { enabled: false });
				ctx.ui.notify("notifi disabled", "info");
				return;
			}

			if (subcommand === "test") {
				await notify(pi, ctx, "finished");
				ctx.ui.notify("notifi test sent", "info");
				return;
			}

			ctx.ui.notify(`notifi is ${state.enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
