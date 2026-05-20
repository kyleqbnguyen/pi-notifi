import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type NotifiState = {
	enabled: boolean;
};

type TaskStatus = "finished" | "error" | "aborted";

type NotifiConfig = {
	disabled: boolean;
	title?: string;
	body?: string;
	urgency?: string;
	icon?: string;
	expireTime?: string;
	notifyOnError: boolean;
	notifyOnAbort: boolean;
};

type NotifiFileConfig = Partial<{
	disabled: boolean;
	title: string;
	body: string;
	urgency: string;
	icon: string;
	expireTime: string | number;
	notifyOnError: boolean;
	notifyOnAbort: boolean;
}>;

type TmuxLocation = {
	sessionId: string;
	windowId: string;
	sessionName?: string;
	windowIndex?: string;
};

type TmuxClient = {
	pid: number;
	tty?: string;
	sessionId: string;
	windowId: string;
};

type HyprClient = {
	address?: string;
	pid?: number;
	mapped?: boolean;
	hidden?: boolean;
	visible?: boolean;
	workspace?: {
		id?: number;
	};
};

type NotifiTarget = {
	id: string;
	workspaceId?: number;
	hyprWindowAddress?: string;
	tmuxSessionId: string;
	tmuxWindowId: string;
	tmuxClientTty?: string;
	timestamp: number;
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

const env = (name: string): string | undefined => {
	const value = process.env[name];
	return value && value.trim().length > 0 ? value : undefined;
};

const fileExists = async (path: string): Promise<boolean> => {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
};

const targetFile = (targetId: string): string => join(process.env.HOME ?? "/tmp", ".cache", "notifi", "targets", `${targetId}.json`);

const readConfigFile = async (cwd: string): Promise<NotifiFileConfig> => {
	const paths = [join(cwd, ".pi", "notifi.json"), join(process.env.HOME ?? "", ".pi", "agent", "notifi.json")];

	for (const path of paths) {
		if (!path || !(await fileExists(path))) continue;
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw) as NotifiFileConfig;
	}

	return {};
};

const configString = (value: unknown): string | undefined => {
	if (typeof value === "string" && value.trim().length > 0) return value;
	if (typeof value === "number") return String(value);
	return undefined;
};

const configBoolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);

const statusBody = (status: TaskStatus): string => {
	if (status === "finished") return "Task Finished";
	if (status === "aborted") return "Task Aborted";
	return "Task Failed";
};

const getTmuxSessionTitle = async (pi: ExtensionAPI): Promise<string | undefined> => {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return undefined;

	try {
		const result = await pi.exec("tmux", ["display-message", "-p", "-t", pane, "#S:#{window_index}"], {
			timeout: 2000,
		});
		const title = result.stdout.trim();
		return title || undefined;
	} catch {
		return undefined;
	}
};

const getConfig = async (pi: ExtensionAPI, ctx: ExtensionContext, status: TaskStatus): Promise<NotifiConfig> => {
	const [tmuxTitle, fileConfig] = await Promise.all([getTmuxSessionTitle(pi), readConfigFile(ctx.cwd)]);

	return {
		disabled: truthy(process.env.PI_NOTIFI_DISABLED) || configBoolean(fileConfig.disabled) === true,
		title: env("PI_NOTIFI_TITLE") ?? configString(fileConfig.title) ?? tmuxTitle ?? "pi",
		body: env("PI_NOTIFI_BODY") ?? configString(fileConfig.body) ?? statusBody(status),
		urgency: env("PI_NOTIFI_URGENCY") ?? configString(fileConfig.urgency) ?? (status === "finished" ? "normal" : "critical"),
		icon: env("PI_NOTIFI_ICON") ?? configString(fileConfig.icon),
		expireTime: env("PI_NOTIFI_EXPIRE_TIME") ?? configString(fileConfig.expireTime) ?? "0",
		notifyOnError: !truthy(process.env.PI_NOTIFI_NOTIFY_ON_ERROR_DISABLED) && configBoolean(fileConfig.notifyOnError) !== false,
		notifyOnAbort: truthy(process.env.PI_NOTIFI_NOTIFY_ON_ABORT) || configBoolean(fileConfig.notifyOnAbort) === true,
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
		const result = await pi.exec("tmux", ["display-message", "-p", "-t", pane, "#{session_id}\t#{window_id}\t#S\t#{window_index}"], {
			timeout: 2000,
		});
		const [sessionId, windowId, sessionName, windowIndex] = result.stdout.trim().split("\t");
		if (!sessionId || !windowId) return undefined;
		return { sessionId, windowId, sessionName, windowIndex };
	} catch {
		return undefined;
	}
};

const getTmuxClients = async (pi: ExtensionAPI): Promise<TmuxClient[]> => {
	try {
		const result = await pi.exec(
			"tmux",
			["list-clients", "-F", "#{client_pid}\t#{client_tty}\t#{session_id}\t#{window_id}"],
			{ timeout: 2000 },
		);

		return result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const [pidText, tty, sessionId, windowId] = line.split("\t");
				return { pid: Number(pidText), tty, sessionId, windowId };
			})
			.filter((client) => Number.isInteger(client.pid) && client.pid > 0 && !!client.sessionId && !!client.windowId);
	} catch {
		return [];
	}
};

const getTmuxClientsForWindow = async (pi: ExtensionAPI, location: TmuxLocation): Promise<TmuxClient[]> => {
	const clients = await getTmuxClients(pi);
	return clients.filter((client) => client.sessionId === location.sessionId && client.windowId === location.windowId);
};

const getTmuxClientsForSession = async (pi: ExtensionAPI, location: TmuxLocation): Promise<TmuxClient[]> => {
	const clients = await getTmuxClients(pi);
	return clients.filter((client) => client.sessionId === location.sessionId);
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

const hyprClientIsUsable = (client: HyprClient): boolean => {
	return (
		typeof client.address === "string" &&
		client.address.length > 0 &&
		typeof client.workspace?.id === "number" &&
		client.mapped !== false &&
		client.hidden !== true
	);
};

const hyprClientIsVisible = (client: HyprClient, visibleWorkspaceIds: Set<number>): boolean => {
	const workspaceId = client.workspace?.id;
	return hyprClientIsUsable(client) && typeof workspaceId === "number" && visibleWorkspaceIds.has(workspaceId) && client.visible !== false;
};

const getHyprState = async (pi: ExtensionAPI): Promise<{ clients: HyprClient[]; visibleWorkspaceIds: Set<number> } | undefined> => {
	try {
		const [clientsResult, monitorsResult] = await Promise.all([
			pi.exec("hyprctl", ["clients", "-j"], { timeout: 3000 }),
			pi.exec("hyprctl", ["monitors", "-j"], { timeout: 3000 }),
		]);

		const clients = parseJsonArray<HyprClient>(clientsResult.stdout);
		const monitors = parseJsonArray<HyprMonitor>(monitorsResult.stdout);
		if (!clients || !monitors) return undefined;

		return { clients, visibleWorkspaceIds: getVisibleHyprWorkspaceIds(monitors) };
	} catch {
		return undefined;
	}
};

const findHyprWindowForTmuxClient = async (
	tmuxClientPid: number,
	hyprClients: HyprClient[],
): Promise<HyprClient | undefined> => {
	const ancestorPids = new Set(await getAncestorPids(tmuxClientPid));
	return hyprClients.find((client) => typeof client.pid === "number" && ancestorPids.has(client.pid) && hyprClientIsUsable(client));
};

const getPiTmuxWindowTarget = async (pi: ExtensionAPI, targetId: string): Promise<NotifiTarget | undefined> => {
	const location = await getTmuxLocation(pi);
	if (!location) return undefined;

	const baseTarget: NotifiTarget = {
		id: targetId,
		tmuxSessionId: location.sessionId,
		tmuxWindowId: location.windowId,
		timestamp: Date.now(),
	};

	const [sessionClients, hyprState] = await Promise.all([getTmuxClientsForSession(pi, location), getHyprState(pi)]);
	if (sessionClients.length === 0 || !hyprState) return baseTarget;

	// Prefer a client already viewing the target window. If none exists, use any
	// attached client for the same session, focus its Ghostty, then switch it to
	// the target tmux window. This avoids opening a new Ghostty when the session
	// is already visible but currently on a different tmux window.
	const tmuxClients = [
		...sessionClients.filter((client) => client.windowId === location.windowId),
		...sessionClients.filter((client) => client.windowId !== location.windowId),
	];

	for (const tmuxClient of tmuxClients) {
		const hyprWindow = await findHyprWindowForTmuxClient(tmuxClient.pid, hyprState.clients);
		if (!hyprWindow || typeof hyprWindow.workspace?.id !== "number" || !hyprWindow.address) continue;

		return {
			...baseTarget,
			workspaceId: hyprWindow.workspace.id,
			hyprWindowAddress: hyprWindow.address,
			tmuxClientTty: tmuxClient.tty,
		};
	}

	return baseTarget;
};

const piTmuxWindowIsVisible = async (pi: ExtensionAPI): Promise<boolean> => {
	const location = await getTmuxLocation(pi);
	if (!location) return false;

	const [tmuxClients, hyprState] = await Promise.all([getTmuxClientsForWindow(pi, location), getHyprState(pi)]);
	if (tmuxClients.length === 0 || !hyprState) return false;

	for (const tmuxClient of tmuxClients) {
		const hyprWindow = await findHyprWindowForTmuxClient(tmuxClient.pid, hyprState.clients);
		if (hyprWindow && hyprClientIsVisible(hyprWindow, hyprState.visibleWorkspaceIds)) return true;
	}

	return false;
};

const writeTarget = async (target: NotifiTarget | undefined): Promise<void> => {
	if (!target) return;
	const path = targetFile(target.id);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(target, null, 2)}\n`, "utf8");
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

const sendNotification = async (pi: ExtensionAPI, config: NotifiConfig, targetId: string | undefined): Promise<void> => {
	await pi.exec(
		"bash",
		[
			"-c",
			[
				"set -euo pipefail",
				"title=$1",
				"body=$2",
				"urgency=$3",
				"expire_time=$4",
				"icon=$5",
				"target_id=$6",
				"args=(--app-name pi --urgency \"$urgency\" --expire-time \"$expire_time\")",
				"if [[ -n \"$icon\" ]]; then args+=(--icon \"$icon\"); fi",
				"if [[ -z \"$target_id\" ]]; then",
				"  notify-send \"${args[@]}\" \"$title\" \"$body\"",
				"else",
				"  args=(--wait --action=focus=Focus \"${args[@]}\")",
				"  (",
				"    action=$(notify-send \"${args[@]}\" \"$title\" \"$body\" || true)",
				"    if [[ \"$action\" == \"focus\" ]]; then",
				"      /home/red/dotfiles/hypr/scripts/notifi-focus \"$target_id\" >/dev/null 2>&1 || true",
				"    fi",
				"  ) >/tmp/notifi-action.log 2>&1 &",
				"fi",
			].join("\n"),
			"notifi-send",
			config.title ?? "pi",
			config.body ?? "Task Finished",
			config.urgency ?? "normal",
			config.expireTime ?? "0",
			config.icon ?? "",
			targetId ?? "",
		],
		{ timeout: 5000 },
	);
};

const notify = async (pi: ExtensionAPI, ctx: ExtensionContext, status: TaskStatus) => {
	const config = await getConfig(pi, ctx, status);
	if (config.disabled) return;
	if (status === "aborted" && !config.notifyOnAbort) return;
	if (status === "error" && !config.notifyOnError) return;
	if (await piTmuxWindowIsVisible(pi)) return;

	try {
		const targetId = randomUUID();
		const target = await getPiTmuxWindowTarget(pi, targetId);
		await writeTarget(target);
		await sendNotification(pi, config, target?.id);
	} catch (error) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`notifi: notify-send failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}
};

export default function (pi: ExtensionAPI) {
	let state: NotifiState = {
		enabled: true,
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
		if (!ctx.hasUI) return;
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
