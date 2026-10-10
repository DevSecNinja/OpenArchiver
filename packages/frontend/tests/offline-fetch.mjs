const originalFetch = globalThis.fetch;

// Layout rendering checks upstream releases; keep that unrelated request deterministic offline.
globalThis.fetch = (input, init) => {
	const url = new URL(input instanceof Request ? input.url : input);
	if (url.href === 'https://api.github.com/repos/LogicLabs-OU/OpenArchiver/releases/latest') {
		return Promise.resolve(new Response(null, { status: 404 }));
	}
	if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
		throw new Error(`Unexpected external request in frontend regression: ${url.origin}`);
	}
	return originalFetch(input, init);
};
