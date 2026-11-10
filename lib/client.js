
window.__ModuleLoader__.load({
	id: "dsh-plugin-goal-ledger",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		//#region view model
		/** Empty reading, used before a session's unit has produced a value. */
		const EMPTY = { turn: 0, main: null, nodes: [], hidden: 0, drift: 0, draft: null };

		/** Fallback so a missing store degrades to the empty reading instead of a render crash. */
		const EMPTY_STORE = {
			get: () => EMPTY,
			subscribe: () => () => {}
		};

		/** Relation tag → label + ink colours for the notepad chips. */
		const RELATION_META = {
			continue: { label: "承继", ink: "#1a56db", paper: "#e8f0fe" },
			refine: { label: "细化", ink: "#0f766e", paper: "#dcf2ee" },
			branch: { label: "分支", ink: "#6d28d9", paper: "#ece7fd" },
			aside: { label: "旁支", ink: "#b45309", paper: "#fdf1d3" },
			root: { label: "新线", ink: "#4b5563", paper: "#e8e6e0" }
		};

		/** One store per session: stable get/subscribe pair over the projection face. */
		function createStore(sessions, sessionId) {
			const empty = EMPTY;
			return {
				get() {
					try {
						const binding = sessions.binding(sessionId);
						const face = binding?.session?.projections?.faceOf?.("goalLedger");
						const value = face?.getSnapshot?.();
						return value ?? empty;
					} catch {
						return empty;
					}
				},
				subscribe(listener) {
					let dispose = () => {};
					try {
						const binding = sessions.binding(sessionId);
						const face = binding?.session?.projections?.faceOf?.("goalLedger");
						if (typeof face?.subscribe === "function") dispose = face.subscribe(listener) ?? dispose;
					} catch {
						dispose = () => {};
					}
					return () => {
						try {
							dispose();
						} catch {}
					};
				}
			};
		}

		/** How long the host parks a request while nothing changed. */
		const MODEL_WAIT_MS = 10000;
		/** Back-off after a failed request. */
		const MODEL_RETRY_MS = 2500;

		/**
		 * Long-polls `GET /goal-ledger/state` on the same origin. The host holds the
		 * request until the ledger changes (a finished turn or a completed backfill),
		 * so the card updates immediately instead of on a timer — and the request
		 * costs nothing while idle.
		 */
		function createModelStore(sessionId) {
			let value = null;
			let running = false;
			let controller = null;
			const listeners = new Set();

			const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

			const loop = async () => {
				while (running) {
					try {
						controller = new AbortController();
						const since = value === null ? -1 : (value.rev ?? 0);
						const response = await fetch(
							`/goal-ledger/state?session=${encodeURIComponent(sessionId)}&since=${since}&wait=${MODEL_WAIT_MS}`,
							{
								credentials: "same-origin",
								headers: { accept: "application/json" },
								signal: controller.signal
							}
						);
						if (!running) return;
						if (!response.ok) {
							await sleep(MODEL_RETRY_MS);
							continue;
						}
						const data = await response.json();
						if (data === null || data.source !== "model") {
							await sleep(MODEL_RETRY_MS);
							continue;
						}
						const nextRev = typeof data.rev === "number" ? data.rev : 0;
						const prevRev = value === null ? -1 : (value.rev ?? 0);
						value = data;
						if (nextRev !== prevRev) {
							for (const listener of listeners) {
								try {
									listener();
								} catch {}
							}
						}
					} catch {
						if (!running) return;
						await sleep(MODEL_RETRY_MS);
					}
				}
			};

			return {
				get: () => value,
				subscribe(listener) {
					listeners.add(listener);
					if (!running) {
						running = true;
						void loop();
					}
					return () => {
						listeners.delete(listener);
						if (listeners.size === 0) {
							running = false;
							try {
								controller?.abort();
							} catch {}
						}
					};
				}
			};
		}
		//#endregion

		//#region paper styles
		const FONT = '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
		const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

		const PAPER = {
			position: "relative",
			boxSizing: "border-box",
			gridColumn: "1 / -1",
			flexBasis: "100%",
			width: "100%",
			minWidth: 0,
			marginTop: 8,
			padding: "9px 14px 8px",
			borderRadius: 3,
			border: "1px solid #e2d7ba",
			background: "linear-gradient(180deg, #fffdf5 0%, #fcf6e4 100%)",
			boxShadow: "0 6px 18px rgba(0,0,0,.30), 0 1px 0 rgba(255,255,255,.8) inset",
			color: "#2f2a24",
			fontFamily: FONT,
			overflow: "hidden"
		};

		/** A folded bottom-right corner, the cheapest way to read as paper. */
		const CORNER = {
			position: "absolute",
			right: 0,
			bottom: 0,
			width: 18,
			height: 18,
			background: "linear-gradient(135deg, transparent 0 50%, #ece0bd 50% 100%)",
			pointerEvents: "none"
		};

		/** The red margin rule every notebook has. */
		const BODY = {
			position: "relative",
			marginTop: 7,
			paddingLeft: 13,
			borderLeft: "1.5px solid rgba(192,57,43,.22)",
			minWidth: 0
		};

		const HEAD = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			minWidth: 0,
			paddingBottom: 7,
			borderBottom: "1px dashed rgba(47,42,36,.16)",
			cursor: "pointer",
			userSelect: "none"
		};

		const BRAND = {
			display: "inline-flex",
			alignItems: "center",
			gap: 6,
			fontSize: 11,
			letterSpacing: ".14em",
			textTransform: "uppercase",
			color: "#8a7c5f",
			flex: "0 0 auto"
		};

		const DRIFT = {
			flex: "0 0 auto",
			fontSize: 10.5,
			fontWeight: 700,
			padding: "1px 7px",
			borderRadius: 2,
			color: "#fff6e8",
			background: "#c0392b",
			transform: "rotate(-2deg)",
			boxShadow: "0 1px 2px rgba(0,0,0,.25)"
		};

		const CHEVRON = {
			marginLeft: "auto",
			flex: "0 0 auto",
			width: 20,
			height: 20,
			borderRadius: 3,
			border: "1px solid rgba(47,42,36,.18)",
			background: "rgba(255,255,255,.5)",
			color: "#6b6357",
			fontSize: 11,
			lineHeight: "18px",
			textAlign: "center",
			cursor: "pointer",
			padding: 0
		};

		const MAIN_TEXT = {
			fontSize: 14.5,
			fontWeight: 600,
			lineHeight: "22px",
			color: "#2b2620",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			minWidth: 0
		};

		const META = {
			flex: "0 0 auto",
			fontSize: 10.5,
			color: "#9a9080",
			fontFamily: MONO
		};

		const PROGRESS_BLOCK = {
			display: "flex",
			gap: 7,
			alignItems: "flex-start",
			fontSize: 12,
			lineHeight: "19px",
			color: "#4a443b",
			minWidth: 0
		};

		const NODE = {
			display: "flex",
			flexDirection: "column",
			gap: 0,
			minWidth: 0,
			padding: "3px 5px",
			borderRadius: 2
		};

		const NODE_LINE = {
			display: "flex",
			alignItems: "center",
			gap: 7,
			minWidth: 0,
			fontSize: 12,
			lineHeight: "18px",
			color: "#4a443b"
		};

		const NODE_PROGRESS = {
			fontSize: 11,
			lineHeight: "16px",
			color: "#8a8172",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			paddingLeft: 2
		};
		//#endregion

		function notebookIcon() {
			return React.createElement(
				"svg",
				{ width: 13, height: 13, viewBox: "0 0 16 16", "aria-hidden": "true" },
				React.createElement("rect", {
					x: 2.2,
					y: 1.6,
					width: 11.6,
					height: 12.8,
					rx: 1.6,
					fill: "#fffdf5",
					stroke: "#7d6f52",
					strokeWidth: 1.3
				}),
				React.createElement("path", {
					d: "M3.4 2v12",
					stroke: "#c0392b",
					strokeWidth: 1.1,
					strokeLinecap: "round",
					opacity: 0.8
				}),
				React.createElement("path", {
					d: "M5.4 5.2h6.4M5.4 8h6.4M5.4 10.7h4.2",
					stroke: "#9c8b6b",
					strokeWidth: 1,
					strokeLinecap: "round"
				})
			);
		}

		function chip(text, style) {
			return React.createElement("span", { style }, text);
		}

		function relationChip(relation) {
			const meta = RELATION_META[relation] ?? RELATION_META.root;
			return chip(meta.label, {
				flex: "0 0 auto",
				fontSize: 10.5,
				fontWeight: 600,
				padding: "0 5px",
				borderRadius: 2,
				color: meta.ink,
				background: meta.paper,
				boxShadow: "0 0 0 1px rgba(47,42,36,.06) inset"
			});
		}

		function clampText(text, limit) {
			const value = String(text ?? "");
			return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
		}

		const OPEN_KEY = "goal-ledger:open";

		/**
		 * Render barrier: a bad turn of ours may only cost the notepad. Without it a
		 * throw inside the note unmounts the conversation subtree it sits in.
		 * Built lazily so module evaluation never touches `React.Component`.
		 */
		let NoteBoundaryClass = null;

		function noteBoundary() {
			if (NoteBoundaryClass === null) {
				NoteBoundaryClass = class extends React.Component {
					constructor(props) {
						super(props);
						this.state = { failed: false };
					}

					static getDerivedStateFromError() {
						return { failed: true };
					}

					componentDidCatch(error) {
						console.warn("[goal-ledger] notepad disabled after a render error:", error);
					}

					render() {
						return this.state.failed ? null : this.props.children;
					}
				};
			}
			return NoteBoundaryClass;
		}

		function readOpen() {
			try {
				const stored = window.localStorage.getItem(OPEN_KEY);
				return stored === null ? true : stored === "1";
			} catch {
				return true;
			}
		}

		function writeOpen(value) {
			try {
				window.localStorage.setItem(OPEN_KEY, value ? "1" : "0");
			} catch {}
		}

		/**
		 * The notepad card: an overview sentence first (where the session started,
		 * what it has become, how many goals it split into), then the latest
		 * progress, then the goal list oldest → newest. `full` shows every goal with
		 * untruncated text; the compact card shows the last four and a "看全部" button.
		 */
		/**
		 * One row of the task tree. A node with children expands **in place**: its
		 * children render directly underneath, indented, instead of opening a wider
		 * panel. Roots read "任务 N", children carry a dotted path ("1.2.1").
		 */
		/**
		 * One line per task. Nothing but a mark, the task name, and—for the task in
		 * progress—one short line of what is happening. Finished tasks open on click
		 * to show their one-line closing summary; tasks with children open to show
		 * the branches.
		 */
		function LedgerTreeNode(props) {
			const node = props.node;
			const depth = props.depth ?? 0;
			const children = Array.isArray(node.children) ? node.children : [];
			const hasChildren = children.length > 0;
			const [open, setOpen] = React.useState(node.open === true);

			const active = node.active === true;
			const done = node.done === true;
			const hasSummary = typeof node.summary === "string" && node.summary !== "";
			const expandable = hasChildren || hasSummary;
			// Pre-quest-log presentation: done tasks keep their normal colour, the
			// current one is marked with a dot, and a click opens branches + summary.
			const detail = active ? (node.progress ?? "") : open ? (node.summary || node.progress || "") : "";
			const mark = done ? "✓" : active ? "●" : "○";
			const markColor = done ? "#3f8f5f" : active ? "#b45309" : "#c0b6a2";

			return React.createElement(
				React.Fragment,
				null,
				React.createElement(
					"div",
					{
						onClick: () => setOpen(!open),
						style: Object.assign({}, NODE_LINE, {
							padding: "2px 4px",
							paddingLeft: 2 + depth * 14,
							borderRadius: 2,
							cursor: "pointer",
							background: active ? "rgba(250,204,21,.26)" : "transparent"
						})
					},
					React.createElement(
						"span",
						{
							onClick: (event) => {
								if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
								if (hasChildren) setOpen(!open);
							},
							style: {
								flex: "0 0 auto",
								width: 12,
								textAlign: "center",
								fontSize: 9,
								color: "#b6ac97"
							}
						},
						expandable ? (open ? "▾" : "▸") : ""
					),
					React.createElement(
						"span",
						{ style: { flex: "0 0 auto", width: 12, textAlign: "center", fontSize: 10, color: markColor } },
						mark
					),
					React.createElement(
						"span",
						{
							style: {
								flex: "1 1 auto",
								minWidth: 0,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
								fontWeight: active ? 600 : 400,
								color: active ? "#2b2620" : done ? "#6b6357" : "#4a443b",
								textDecoration: "none"
							}
						},
						node.label
					)
				),
				detail === ""
					? null
					: React.createElement(
							"div",
							{
								style: {
									paddingLeft: 26 + depth * 14,
									fontSize: 11,
									lineHeight: "16px",
									color: "#8a8172",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap"
								}
							},
							detail
						),
				open && hasChildren
					? children.map((child) =>
							React.createElement(LedgerTreeNode, {
								key: child.id,
								node: child,
								depth: depth + 1
							})
						)
					: null
			);
		}



		/**
		 * The card: a title, a done/total counter, and the task lines. No overview
		 * paragraph, no per-turn rows, no legend — the note is meant to be glanced at.
		 */
		function GoalLedgerNote(props) {
			const view = props.view ?? EMPTY;
			const tasks = view.tasks ?? [];
			const total = view.total ?? 0;
			
			const drift = view.drift ?? 0;

			const head = React.createElement(
				"div",
				{ style: HEAD },
				React.createElement("span", { style: BRAND }, notebookIcon(), "目标日志"),
				React.createElement("span", { style: META }, total === 0 ? "空" : `${total} 个目标`),
				drift > 0 ? chip(`${drift}`, DRIFT) : null
			);

			const body = React.createElement(
				"div",
				{ style: BODY },
				tasks.length === 0
					? React.createElement(
							"div",
							{ style: { fontSize: 11.5, color: "#8a8172", lineHeight: "18px" } },
							"等待第一轮"
						)
					: tasks.map((task) =>
							React.createElement(LedgerTreeNode, { key: task.id, node: task, depth: 0 })
						)
			);

			return React.createElement(
				"div",
				{ style: PAPER },
				React.createElement("div", { style: CORNER }),
				head,
				body
			);
		}


		/**
		 * Header entry point. `conversation.header` is a single-occupant slot owned by
		 * the session header itself, so the note cannot live there; the actions list
		 * is the only multi-occupant slot in that bar. It carries a small paper chip
		 * which opens the full notepad as a fixed-position card, so the card is never
		 * clipped by the header's overflow.
		 */
		function GoalLedgerChip(props) {
			const store = props.store ?? EMPTY_STORE;
			const modelStore = props.modelStore ?? EMPTY_STORE;
			const projected = React.useSyncExternalStore(store.subscribe, store.get, store.get);
			const modeled = React.useSyncExternalStore(modelStore.subscribe, modelStore.get, modelStore.get);
			// The model ledger wins when it has verdicts; the rule projection is the
			// instant fallback for the first turn and for every failure of the route.
			const view = modeled !== null && (modeled.total ?? 0) > 0 ? modeled : projected;
			const [anchor, setAnchor] = React.useState(null);

			const drift = view.drift ?? 0;
			const main = view.main ?? null;

			const ping = (mark) => {
				// Diagnostic beacon: proves whether a click ever reached the chip, which
				// is the one thing the host cannot observe from here.
				try {
					fetch(`/goal-ledger/ping?session=${encodeURIComponent(props.sessionId ?? "")}&m=${mark}`, {
						credentials: "same-origin",
						keepalive: true
					}).catch(() => {});
				} catch {}
			};

			// Open state only. The card is laid out inline under the chip: the session
			// header sets `container-type: inline-size`, which makes it the containing
			// block for `position: fixed` descendants, so viewport coordinates land in
			// a 30px strip and the card is never seen.
			const toggle = () => {
				const next = anchor === null;
				ping(next ? "open" : "close");
				setAnchor(next ? true : null);
			};

			const close = () => setAnchor(null);

			const chip = React.createElement(
				"button",
				{
					type: "button",
					onClick: toggle,
					title: main === null ? "目标日志：还没有识别到主线" : `目标日志：${main.label}`,
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 5,
						height: 24,
						padding: "0 9px",
						marginLeft: 6,
						borderRadius: 3,
						border: "1px solid #ded3b4",
						background: "linear-gradient(180deg, #fffdf5 0%, #fbf4e0 100%)",
						boxShadow: "0 1px 2px rgba(0,0,0,.18)",
						color: "#5b5240",
						fontFamily: FONT,
						fontSize: 11,
						lineHeight: "22px",
						cursor: "pointer",
						flex: "0 0 auto",
						whiteSpace: "nowrap",
						// The session header doubles as the window drag strip in the desktop
						// shell; without this the click never reaches the button.
						WebkitAppRegion: "no-drag",
						position: "relative",
						zIndex: 2147483001
					}
				},
				notebookIcon(),
				"目标日志",
				drift > 0
					? React.createElement(
							"span",
							{
								style: {
									marginLeft: 2,
									padding: "0 4px",
									borderRadius: 2,
									background: "#c0392b",
									color: "#fff6e8",
									fontSize: 10,
									fontWeight: 700
								}
							},
							String(drift)
						)
					: null
			);

			// The dock is a plain column above the composer, so the card can sit in
			// normal flow right above the chip — no positioning, no clipping, and it
			// never covers the thread. It does push the composer down while open.
			return React.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, width: "100%" } },
				anchor === null
					? null
					: React.createElement(
							"div",
							{
								key: "card",
								// Self-check: once the card is in the DOM it reports its own size.
								// A zero-height report means "rendered but invisible", which is
								// exactly the failure that cost several rounds earlier.
								ref: (element) => {
									if (element === null) return;
									try {
										const rect = element.getBoundingClientRect();
										fetch(
											`/goal-ledger/ping?m=card&w=${Math.round(rect.width)}&h=${Math.round(rect.height)}`,
											{ credentials: "same-origin", keepalive: true }
										).catch(() => {});
									} catch {}
								},
								style: {
									width: 460,
									maxWidth: "100%",
									maxHeight: "52vh",
									overflowY: "auto"
								}
							},
							React.createElement(GoalLedgerNote, { view })
						),
				chip
			);
		}
		//#endregion

		//#region plugin
		const inject = ["slots", "sessions"];

		/**
		 * Register the notepad chip in the session header's action list.
		 *
		 * Three hard-won constraints, all about not taking the shell down with us:
		 *   - **Pick a list slot.** `conversation.header` is `kind: "single"` and is
		 *     already occupied by the session header component, so entries there are
		 *     dropped without any error; `…session.header.actions` is the list slot in
		 *     the same bar.
		 *   - **Load after the slot owners.** `dsh.client.inject` in package.json
		 *     orders this bundle behind the UI packages that declare the slots.
		 *   - **Never throw.** Registration is deferred one task and wrapped, so a
		 *     bad slot name or a missing service costs the chip, not the boot.
		 */
		function apply(ctx) {
			const stores = new Map();
			const modelStores = new Map();
			const storeFor = (sessionId) => {
				let store = stores.get(sessionId);
				if (store === undefined) {
					store = createStore(ctx.sessions, sessionId);
					stores.set(sessionId, store);
				}
				return store;
			};
			const modelStoreFor = (sessionId) => {
				let store = modelStores.get(sessionId);
				if (store === undefined) {
					store = createModelStore(sessionId);
					modelStores.set(sessionId, store);
				}
				return store;
			};

			const register = () => {
				try {
					// Emergency off switch for a shell that misbehaves:
					// localStorage.setItem("goal-ledger:disabled", "1") then reload.
					if (window.localStorage.getItem("goal-ledger:disabled") === "1") return;
				} catch {}
				try {
					// The session header is unusable for an overlay: its `container-type`
					// makes it a stacking context, so anything we draw inside it paints
					// under the thread and never appears. The composer dock is the one
					// place this shell renders extra rows without clipping or stacking
					// surprises, so the chip lives there and the card opens above it.
					ctx.slots.inject("conversation.input.dock", () => {
						const dispose = ctx.slots.register(
							{
								name: "conversation.input.dock",
								id: "goal-ledger",
								order: 20,
								inject: (sessionId) => ({ sessionId })
							},
							(props) => {
								// No session on screen (home / new-session hero): no ledger to show.
								const sessionId = props.sessionId ?? props.session?.id;
								if (sessionId === undefined || sessionId === null) return null;
								return React.createElement(
									noteBoundary(),
									null,
									React.createElement(GoalLedgerChip, {
										store: storeFor(sessionId),
										modelStore: modelStoreFor(sessionId),
										sessionId
									})
								);
							}
						);
						// Owning the entry is what makes "disable the plugin" remove it: the
						// disposer rides this plugin's fiber. Registering from a timer (the
						// old code did) escaped that scope and the chip outlived the plugin.
						try {
							ctx.effect(() => dispose);
						} catch {}
						return dispose;
					});
				} catch (error) {
					console.warn("[goal-ledger] slot registration skipped:", error);
				}
			};

			// Synchronous on purpose. Slot ownership is already ordered by
			// `dsh.client.inject`, so a deferred registration buys nothing and loses
			// the fiber's cleanup.
			register();
		}
		//#endregion

		exports.GoalLedgerNote = GoalLedgerNote;
		exports.GoalLedgerChip = GoalLedgerChip;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
