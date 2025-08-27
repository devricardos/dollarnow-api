/**
 * DollarNow Resilient API Fetcher v3.0
 *
 * This Worker fetches currency exchange rates from multiple APIs with a fallback strategy
 * to ensure high availability. It processes and standardizes the data, providing a
 * consistent and reliable format for all client applications.
 *
 * It requires environment variables (secrets) to be set in the Cloudflare dashboard.
 */

// --- Configuration ---

const FIAT_SYMBOLS = ['BRL', 'EUR', 'JPY', 'GBP', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'NZD', 'SEK', 'INR', 'PKR', 'IDR', 'MXN'];
const ASSET_SYMBOLS = ['BTC', 'XAU', 'XAG', 'XBR']; // XAU: Gold, XAG: Silver, XBR: Brent Oil

// --- Type Definitions for Safety ---

export interface Env {
	AWESOME_API_TOKEN: string;
	WISE_API_KEY: string;
	UNIRATE_API_KEY: string;
	EXCHANGERATE_API_KEY: string;
}

interface AwesomeApiItem {
	code: string;
	codein: string;
	name: string;
	bid: string;
	timestamp: string;
}

interface AwesomeApiResponse {
	[key: string]: AwesomeApiItem;
}

// --- API Fetcher Definitions ---

const apiFetchers = [
	// 1. Awesome API (Primary)
	async (env: Env) => {
		if (!env.AWESOME_API_TOKEN) throw new Error('AWESOME_API_TOKEN is not configured.');

		const fiatPairs = FIAT_SYMBOLS.map((s) => `USD-${s}`);
		const assetPairs = ASSET_SYMBOLS.map((s) => `${s}-USD`);
		const allPairs = [...fiatPairs, ...assetPairs].join(',');

		const response = await fetch(`https://economia.awesomeapi.com.br/json/last/${allPairs}?token=${env.AWESOME_API_TOKEN}`);
		if (!response.ok) throw new Error('Awesome API request failed');
		const data: AwesomeApiResponse = await response.json();

		const rates: { [key: string]: number } = {};
		for (const item of Object.values(data)) {
			const value = parseFloat(item.bid);
			if (isNaN(value)) continue;

			// Standardize the key: if base is USD, use the target currency. Otherwise, use the base asset.
			const key = item.code === 'USD' ? item.codein : item.code;
			rates[key] = value;
		}
		if (Object.keys(rates).length === 0) throw new Error('Awesome API returned no valid rates.');
		console.log('OK: Fetched from Awesome API');
		return rates;
	},

	// 2. Wise API (Fiat Only)
	async (env: Env) => {
		if (!env.WISE_API_KEY) throw new Error('WISE_API_KEY is not configured.');
		const response = await fetch('https://api.wise.com/v1/rates?source=USD', {
			headers: { Authorization: `Bearer ${env.WISE_API_KEY}` }
		});
		if (!response.ok) throw new Error('Wise API request failed');
		const data = await response.json();

		const rates: { [key: string]: number } = {};
		const neededSymbols = new Set(FIAT_SYMBOLS);
		for (const rateInfo of data) {
			if (neededSymbols.has(rateInfo.target)) {
				rates[rateInfo.target] = rateInfo.rate;
			}
		}
		if (Object.keys(rates).length === 0) throw new Error('Wise API returned no valid rates for needed symbols.');
		console.log('OK: Fetched from Wise API');
		return rates;
	}
	// Other fetchers like UniRate and ExchangeRate-API can be added here following the same pattern.
];

// --- Main Worker Logic ---

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const cacheKey = new Request(request.url, request);
		const cache = caches.default;

		let response = await cache.match(cacheKey);
		if (response) {
			console.log('Cache hit!');
			return new Response(response.body, response);
		}
		console.log('Cache miss. Fetching from APIs...');

		let combinedRates: { [key: string]: number } = {};

		for (const fetcher of apiFetchers) {
			try {
				const rates = await fetcher(env);
				if (rates && Object.keys(rates).length > 0) {
					combinedRates = rates;
					break; // Success, exit the loop
				}
			} catch (error) {
				console.warn(`Fetcher failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (Object.keys(combinedRates).length === 0) {
			return new Response(JSON.stringify({ success: false, error: 'All primary API sources are unavailable.' }), {
				status: 503,
				headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
			});
		}

		// Always add the base USD rate
		combinedRates['USD'] = 1;

		const responsePayload = {
			success: true,
			rates: combinedRates,
			updated_at: Math.floor(Date.now() / 1000) // Correct Unix timestamp in seconds
		};

		response = new Response(JSON.stringify(responsePayload), {
			headers: {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*',
				'Cache-Control': 'public, max-age=90' // Updated 90-second cache TTL
			}
		});

		ctx.waitUntil(cache.put(cacheKey, response.clone()));
		return response;
	}
};

