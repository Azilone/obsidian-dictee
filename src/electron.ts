/**
 * The few Electron APIs the plugin uses (desktop only), typed. Obsidian exposes Electron through
 * the renderer's `require`; `remote` may be missing in some Obsidian versions, so callers degrade
 * gracefully when it is null.
 */

export interface WebContentsLike {
	isLoading(): boolean;
	executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
	on(event: 'did-finish-load', listener: () => void): void;
}

export interface BrowserWindowLike {
	webContents: WebContentsLike;
	isDestroyed(): boolean;
	destroy(): void;
	showInactive(): void;
	setAlwaysOnTop(flag: boolean, level?: string): void;
	setVisibleOnAllWorkspaces(flag: boolean, options?: { visibleOnFullScreen?: boolean }): void;
	setContentProtection(enable: boolean): void;
	setMenuBarVisibility?(visible: boolean): void;
	getPosition(): number[];
	on(event: 'moved' | 'closed', listener: () => void): void;
	loadURL(url: string): Promise<void>;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ScreenLike {
	getPrimaryDisplay(): { workArea: Rect };
	getDisplayMatching(rect: Rect): { workArea: Rect } | undefined;
}

export interface RemoteLike {
	BrowserWindow: new (options: Record<string, unknown>) => BrowserWindowLike;
	screen: ScreenLike;
	dialog?: {
		showOpenDialog(options: Record<string, unknown>): Promise<{ canceled: boolean; filePaths: string[] }>;
	};
}

interface ElectronLike {
	remote?: RemoteLike;
	shell?: { openExternal(url: string): Promise<void> };
}

function electron(): ElectronLike | null {
	try {
		const req = (window as unknown as { require?: (id: string) => unknown }).require;
		return (req?.('electron') as ElectronLike | undefined) ?? null;
	} catch {
		return null;
	}
}

export function electronRemote(): RemoteLike | null {
	return electron()?.remote ?? null;
}

export function openExternal(url: string) {
	void electron()?.shell?.openExternal(url);
}
