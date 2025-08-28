/**
 * DollarNow Resilient API Fetcher v3.1
 *
 * This Worker fetches currency exchange rates and standardizes them against a USD base.
 * All returned rates represent how many units of that currency/asset can be bought with 1 USD.
 */

// --- Configuration ---
const FIAT_SYMBOLS = ['BRL', 'EUR', 'JPY', 'GBP', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'NZD', 'SEK', 'INR', 'PKR', 'IDR', 'MXN'];
const ASSET_SYMBOLS = ['BTC', 'XAU', 'XAG', 'XBR'];

// --- Type Definitions ---
export interface Env {
    AWESOME_API_TOKEN: string;
    // Add other API keys here if you expand the fetchers
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
        console.log('Cache miss. Fetching from AwesomeAPI...');

        try {
            const fiatPairs = FIAT_SYMBOLS.map((s) => `USD-${s}`);
            const assetPairs = ASSET_SYMBOLS.map((s) => `${s}-USD`);
            const allPairs = [...fiatPairs, ...assetPairs].join(',');

            const apiResponse = await fetch(`https://economia.awesomeapi.com.br/json/last/${allPairs}?token=${env.AWESOME_API_TOKEN}`);
            if (!apiResponse.ok) {
                throw new Error(`AwesomeAPI request failed with status ${apiResponse.status}`);
            }

            const data: AwesomeApiResponse = await apiResponse.json();
            const processedRates: { [key: string]: number } = { USD: 1 };
            let lastTimestamp = 0;

            for (const item of Object.values(data)) {
                const value = parseFloat(item.bid);
                if (isNaN(value)) continue;

                // This is the core logic for standardization
                if (item.code === 'USD') {
                    // It's a fiat currency (USD-BRL), the value is correct.
                    processedRates[item.codein] = value;
                } else {
                    // It's an asset (BTC-USD), we need to invert the value.
                    // 1 / (USD per Asset) = Assets per USD
                    processedRates[item.code] = 1 / value;
                }

                const currentTimestamp = parseInt(item.timestamp, 10);
                if (currentTimestamp > lastTimestamp) {
                    lastTimestamp = currentTimestamp;
                }
            }

            const responsePayload = {
                success: true,
                rates: processedRates,
                updated_at: lastTimestamp || Math.floor(Date.now() / 1000)
            };

            response = new Response(JSON.stringify(responsePayload), {
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'public, max-age=90'
                }
            });

            ctx.waitUntil(cache.put(cacheKey, response.clone()));
            return response;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return new Response(JSON.stringify({ success: false, error: errorMessage }), {
                status: 503,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }
    }
};