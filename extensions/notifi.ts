import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type NotifiState = {
	enabled: boolean;
};

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
	bellFallback: boolean;
};

const truthy = (value: string | undefined): boolean => {
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const env = (name: string, fallback?: string): string | undefined => {
	const value = process.env[name];
	return value && value.trim().length > 0 ? value : fallback;
};

const statusBody = (status: "finished" | "error" | "aborted"): string => {
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

const getConfig = async (
	pi: ExtensionAPI,
	_statusCtx: ExtensionContext,
	status: "finished" | "error" | "aborted",
): Promise<NotifiConfig> => {
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
		bellFallback: process.env.PI_NOTIFI_BELL_FALLBACK !== "0",
	};
};

const getStatus = (messages: unknown[]): "finished" | "error" | "aborted" => {
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

const notify = async (pi: ExtensionAPI, ctx: ExtensionContext, status: "finished" | "error" | "aborted") => {
	const config = await getConfig(pi, ctx, status);
	if (status === "aborted" && !config.notifyOnAbort) return;
	if (config.onErrorOnly && status === "finished") return;

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
		description: "Manage desktop notifications when pi finishes a task: status | on | off | test",
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
