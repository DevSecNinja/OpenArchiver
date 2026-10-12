export class UnsafePathError extends Error {
	constructor() {
		super('Expected a safe relative path without dot segments, absolute paths or symlinks');
		this.name = 'UnsafePathError';
	}
}

/** Validate before normalization or namespace composition can hide unsafe components. */
export function assertSafeRelativePath(value: string): void {
	if (typeof value !== 'string' || !value || /[\\\0]/.test(value)) {
		throw new UnsafePathError();
	}
	const parts = (value.endsWith('/') ? value.slice(0, -1) : value).split('/');
	if (parts.some((part) => !part || part === '.' || part === '..')) {
		throw new UnsafePathError();
	}
	// POSIX treats colons and trailing dots/spaces literally. On Windows they can
	// address streams, alias another path, or name a device instead of an archive file.
	if (
		process.platform === 'win32' &&
		parts.some(
			(part) =>
				/[:<>"|?*\u0000-\u001f]/.test(part) ||
				/[ .]$/.test(part) ||
				/^(conin\$|conout\$)$/i.test(part) ||
				/^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(
					part
				)
		)
	) {
		throw new UnsafePathError();
	}
}
