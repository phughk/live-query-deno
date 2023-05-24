import {
	type LiveQueryResponse,
	type RawSocketMessageResponse,
	type Result,
	type UnprocessedLiveQueryResponse,
	WebsocketStatus,
} from "../types.ts";
import WebSocket from "./WebSocket/deno.ts";
import { getIncrementalID } from "./getIncrementalID.ts";
import { processUrl } from "./processUrl.ts";

export class SurrealSocket {
	private url: string;
	private onOpen?: () => unknown;
	private onClose?: () => unknown;
	private ws?: WebSocket;
	private status: WebsocketStatus = WebsocketStatus.CLOSED;
	private queue: Record<string, (data: Result) => unknown> = {};
	private liveQueue: Record<
		string,
		((data: LiveQueryResponse) => unknown)[]
	> = {};

	private unprocessedLiveResponses: Record<string, LiveQueryResponse[]> = {};

	public ready: Promise<void>;
	private resolveReady: () => void;

	public closed: Promise<void>;
	private resolveClosed: () => void;

	public socketClosureReason: Record<number, string> = {
		1000: "CLOSE_NORMAL",
	};

	constructor({
		url,
		onOpen,
		onClose,
	}: {
		url: string;
		onOpen?: () => unknown;
		onClose?: () => unknown;
	}) {
		this.resolveReady = () => {}; // Purely for typescript typing :)
		this.ready = new Promise((r) => (this.resolveReady = r));
		this.resolveClosed = () => {}; // Purely for typescript typing :)
		this.closed = new Promise((r) => (this.resolveClosed = r));
		this.onOpen = onOpen;
		this.onClose = onClose;
		this.url = processUrl(url, {
			http: "ws",
			https: "wss",
		}) + "/rpc";
	}

	open() {
		// Close any possibly connected sockets, reset status;
		this.close(1000);
		this.resetReady();

		// Connect to Surreal instance
		this.ws = new WebSocket(this.url);
		this.ws.addEventListener("open", (_e) => {
			this.status = WebsocketStatus.OPEN;
			this.resolveReady();
			this.onOpen?.();
		});

		this.ws.addEventListener("close", (_e) => {
			this.resolveClosed();
			this.resetClosed();

			Object.values(this.liveQueue).map((query) => {
				query.map((cb) =>
					cb({
						action: "CLOSE",
						detail: "SOCKET_CLOSED",
					})
				);
			});

			this.queue = {};
			this.liveQueue = {};
			this.unprocessedLiveResponses = {};

			// Connection retry mechanism
			if (this.status !== WebsocketStatus.CLOSED) {
				this.status = WebsocketStatus.RECONNECTING;

				setTimeout(() => {
					this.open();
				}, 2500);

				this.onClose?.();
			}
		});

		this.ws.addEventListener("message", (e) => {
			const res = JSON.parse(
				e.data.toString(),
			) as RawSocketMessageResponse;
			if ("method" in res && res.method === "notify") {
				this.handleLiveBatch(res.params);
			} else if (res.id && res.id in this.queue) {
				this.queue[res.id](res);
				delete this.queue[res.id];
			}
		});
	}

	// Extracting the pure object to prevent any getters/setters that could break stuff
	// Prevent user from overwriting ID that is being sent
	async send(
		method: string,
		params: unknown[],
		callback: (data: Result) => unknown,
	) {
		await this.ready;

		const id = getIncrementalID();
		this.queue[id] = callback;
		this.ws?.send(JSON.stringify({ id, method, params }));
	}

	async listenLive(
		uuid: string,
		callback: (data: LiveQueryResponse) => unknown,
	) {
		if (!(uuid in this.liveQueue)) this.liveQueue[uuid] = [];
		this.liveQueue[uuid].push(callback);

		// Cleanup unprocessed messages queue
		await Promise.all(this.unprocessedLiveResponses[uuid]?.map(callback) ?? []);
		delete this.unprocessedLiveResponses[uuid];
	}

	async kill(uuid: string) {
		if (uuid in this.liveQueue) {
			this.liveQueue[uuid].forEach((cb) =>
				cb({
					action: "CLOSE",
					detail: "QUERY_KILLED",
				})
			);

			delete this.liveQueue[uuid];
		}

		await new Promise<void>((r) => {
			this.send("kill", [uuid], (_) => {
				if (uuid in this.unprocessedLiveResponses) {
					delete this.unprocessedLiveResponses[uuid];
				}

				r();
			});
		});
	}

	private async handleLiveBatch(messages: UnprocessedLiveQueryResponse[]) {
		await Promise.all(messages.map(async ({ uuid, ...message }) => {
			if (this.liveQueue[uuid]) {
				await Promise.all(
					this.liveQueue[uuid].map(async (cb) => await cb(message)),
				);
			} else {
				if (!(uuid in this.unprocessedLiveResponses)) {
					this.unprocessedLiveResponses[uuid] = [];
				}
				this.unprocessedLiveResponses[uuid].push(message);
			}
		}));
	}

	async close(reason: keyof typeof this.socketClosureReason) {
		this.status = WebsocketStatus.CLOSED;
		this.ws?.close(reason, this.socketClosureReason[reason]);
		this.onClose?.();
		await this.closed;
	}

	get connectionStatus() {
		return this.status;
	}

	private resetReady() {
		this.ready = new Promise((r) => (this.resolveReady = r));
	}

	private resetClosed() {
		this.closed = new Promise((r) => (this.resetClosed = r));
	}
}
