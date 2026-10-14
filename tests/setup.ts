import { mock } from 'bun:test';

// The `obsidian` package ships types only; tests get the little runtime they touch.
mock.module('obsidian', () => ({
	Platform: { isDesktop: true, isDesktopApp: true, isMacOS: true, isMobile: false },
	getLanguage: () => 'en',
}));
