export class UnsafePathError extends Error {
	constructor() {
		super('Expected a safe relative path without dot segments, absolute paths or symlinks');
		this.name = 'UnsafePathError';
	}
}

/** Validate before normalization or namespace composition can hide unsafe components. */
export function assertSafeRelativePath(value: string): void {
	if (typeof value !== 'string' || !value || /[\\:\0]/.test(value)) {
		throw new UnsafePathError();
	}
	const parts = (value.endsWith('/') ? value.slice(0, -1) : value).split('/');
	if (parts.some((part) => !part || part === '.' || part === '..' || /[ .]$/.test(part))) {
		throw new UnsafePathError();
	}
}
