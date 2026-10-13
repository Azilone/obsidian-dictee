/**
 * A small always-on-top pill in its own Electron window, so the user never forgets a recording
 * is running even when Obsidian is hidden. With content protection on, macOS keeps it out of
 * screen sharing and screenshots.
 *
 * No IPC: the plugin pushes state with `executeJavaScript`, and the pill queues clicks in
 * `window.__q`, which the plugin drains on the same tick.
 */

export type OverlayAction = 'toggle' | 'mark' | 'stop' | 'continue' | 'moved';

export interface OverlayState {
	time: string;
	paused: boolean;
	levels: (number | null)[];
	sent: string;
	cost: string;
	/** Idle question shown with a countdown (seconds left) when set. */
	idle: { minutes: number; left: number } | null;
}

export interface OverlayOptions {
	hiddenFromCapture: boolean;
	position: { x: number; y: number } | null;
	onAction: (action: OverlayAction, payload?: unknown) => void;
}

const W = 340;
const H = 44;

const HTML = String.raw`<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#eee;-webkit-user-select:none;user-select:none}
#pill{display:flex;align-items:center;gap:8px;height:${H - 8}px;margin:4px;padding:0 6px 0 12px;border-radius:20px;background:rgba(28,28,30,.92);box-shadow:0 2px 10px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.12);-webkit-app-region:drag}
button{-webkit-app-region:no-drag;appearance:none;border:0;background:transparent;color:#ddd;width:28px;height:28px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
button:hover{background:rgba(255,255,255,.12)}
button.stop{color:#ff5f57}
button svg{width:14px;height:14px;fill:currentColor}
#dot{width:9px;height:9px;border-radius:50%;background:#ff3b30;animation:p 1.4s ease-in-out infinite;flex:none}
body.paused #dot{background:#888;animation:none}
@keyframes p{50%{opacity:.3}}
#time{font-variant-numeric:tabular-nums;min-width:40px}
body.paused #time{color:#888}
#meters{display:inline-flex;gap:3px;align-items:flex-end}
.m{width:4px;height:14px;border-radius:2px;background:rgba(255,255,255,.15);overflow:hidden;position:relative}
.m.off{opacity:.3}
.m i{position:absolute;inset:0;background:#34c759;transform-origin:bottom;transform:scaleY(var(--l,0));transition:transform 120ms linear}
#info{color:#9a9a9e;font-size:11px;white-space:nowrap;flex:1;overflow:hidden;text-overflow:ellipsis}
#ask{display:none;align-items:center;gap:6px;flex:1;font-size:12px;white-space:nowrap}
body.idle #ask{display:flex}
body.idle #info,body.idle #meters{display:none}
#ask button{width:auto;padding:0 8px;height:24px;font-size:12px;background:rgba(255,255,255,.14)}
#ask button.stop{background:rgba(255,95,87,.25)}
</style></head><body>
<div id="pill">
<span id="dot"></span><span id="time">00:00</span><span id="meters"></span><span id="info"></span>
<span id="ask"><span id="askText"></span><button id="cont">Continuer</button><button class="stop" id="askStop">Terminer</button></span>
<button id="toggle" title="Pause"><svg viewBox="0 0 16 16"><path d="M4 2h3v12H4zM9 2h3v12H9z"/></svg></button>
<button id="mark" title="Marquer ce moment"><svg viewBox="0 0 16 16"><path d="M3 1h10v14l-5-3.5L3 15z"/></svg></button>
<button id="stop" class="stop" title="Terminer la réunion"><svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg></button>
</div>
<script>
window.__q=[];
const q=(a)=>window.__q.push(a);
const PAUSE='<svg viewBox="0 0 16 16"><path d="M4 2h3v12H4zM9 2h3v12H9z"/></svg>';
const PLAY='<svg viewBox="0 0 16 16"><path d="M4 2l10 6-10 6z"/></svg>';
let paused=null;
document.getElementById('toggle').onclick=()=>q('toggle');
document.getElementById('mark').onclick=()=>q('mark');
document.getElementById('stop').onclick=()=>q('stop');
document.getElementById('askStop').onclick=()=>q('stop');
document.getElementById('cont').onclick=()=>q('continue');
window.update=(s)=>{
	document.getElementById('time').textContent=s.time;
	document.body.classList.toggle('paused',s.paused);
	document.body.classList.toggle('idle',!!s.idle);
	if(s.paused!==paused){paused=s.paused;const b=document.getElementById('toggle');b.innerHTML=paused?PLAY:PAUSE;b.title=paused?'Reprendre':'Pause';}
	const m=document.getElementById('meters');
	while(m.children.length<s.levels.length){const d=document.createElement('span');d.className='m';d.innerHTML='<i></i>';m.appendChild(d);}
	s.levels.forEach((db,i)=>{const d=m.children[i];d.classList.toggle('off',db==null);d.firstChild.style.setProperty('--l',db==null?0:Math.max(0,Math.min(1,(db+60)/50)));});
	document.getElementById('info').textContent=s.sent+(s.cost?' ≈ '+s.cost:'');
	if(s.idle){document.getElementById('askText').textContent='Silence depuis '+s.idle.minutes+' min — toujours en réunion ? ('+s.idle.left+' s)';}
};
</script></body></html>`;

/* eslint-disable @typescript-eslint/no-explicit-any */
function electronRemote(): any | null {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const electron = require('electron');
		return electron?.remote ?? null;
	} catch {
		return null;
	}
}

export class RecorderOverlay {
	private win: any = null;
	private closedByUser = false;
	private lastState = '';
	private pos: { x: number; y: number } | null;

	constructor(private opts: OverlayOptions) {
		this.pos = opts.position;
	}

	/** False when Electron's remote module is unavailable (no overlay possible). */
	open(): boolean {
		const remote = electronRemote();
		if (!remote?.BrowserWindow) return false;
		const { BrowserWindow, screen } = remote;
		let { x, y } = this.pos ?? this.defaultPosition(screen);
		// Keep it on a visible display even if the layout changed since last time.
		const disp = screen.getDisplayMatching({ x, y, width: W, height: H });
		if (!disp || x < disp.workArea.x - W / 2 || x > disp.workArea.x + disp.workArea.width - W / 2 || y < disp.workArea.y || y > disp.workArea.y + disp.workArea.height - H) {
			({ x, y } = this.defaultPosition(screen));
		}
		const win = new BrowserWindow({
			width: W,
			height: H,
			x: Math.round(x),
			y: Math.round(y),
			frame: false,
			transparent: true,
			resizable: false,
			movable: true,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			skipTaskbar: true,
			hasShadow: false,
			alwaysOnTop: true,
			focusable: false,
			show: false,
			title: 'Meeting Notes',
			webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
		});
		this.win = win;
		win.setAlwaysOnTop(true, 'floating');
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		if (this.opts.hiddenFromCapture) win.setContentProtection(true);
		win.setMenuBarVisibility?.(false);
		win.on('moved', () => {
			const [px, py] = win.getPosition();
			this.pos = { x: px, y: py };
			this.opts.onAction('moved', this.pos);
		});
		win.on('closed', () => {
			this.win = null;
			this.closedByUser = true;
		});
		win.webContents.on('did-finish-load', () => {
			if (this.lastState) void win.webContents.executeJavaScript(`window.update(${this.lastState})`, true).catch(() => {});
			win.showInactive();
		});
		void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
		return true;
	}

	private defaultPosition(screen: any) {
		const { workArea } = screen.getPrimaryDisplay();
		return { x: workArea.x + workArea.width - W - 16, y: workArea.y + 12 };
	}

	get visible(): boolean {
		return !!this.win && !this.win.isDestroyed();
	}

	/** Re-open after the user closed the window. */
	show(): boolean {
		if (this.visible) {
			this.win.showInactive();
			return true;
		}
		this.closedByUser = false;
		return this.open();
	}

	update(state: OverlayState) {
		this.lastState = JSON.stringify(state);
		const win = this.win;
		if (!win || win.isDestroyed() || win.webContents.isLoading()) return;
		void win.webContents.executeJavaScript(`window.update(${this.lastState})`, true).catch(() => {});
	}

	/** Pull clicks queued inside the window and dispatch them. */
	async poll() {
		const win = this.win;
		if (!win || win.isDestroyed() || win.webContents.isLoading()) return;
		let actions: OverlayAction[] = [];
		try {
			actions = await win.webContents.executeJavaScript('(()=>{const a=window.__q||[];window.__q=[];return a;})()', true);
		} catch {
			return;
		}
		for (const a of actions) this.opts.onAction(a);
	}

	destroy() {
		const win = this.win;
		this.win = null;
		if (win && !win.isDestroyed()) win.destroy();
	}
}
