const POLL_INTERVAL_MS = 50;

function withMemProfiler(handler) {
    return async (event, context) => {
        const startedAt = process.hrtime.bigint();
        let peakRss = 0;
        let peakHeapUsed = 0;

        const sample = () => {
            const mem = process.memoryUsage();
            if (mem.rss > peakRss) peakRss = mem.rss;
            if (mem.heapUsed > peakHeapUsed) peakHeapUsed = mem.heapUsed;
        };

        sample();
        const interval = setInterval(sample, POLL_INTERVAL_MS);

        try {
            return await handler(event, context);
        } finally {
            clearInterval(interval);
            sample();
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            console.log(
                "METRICS " +
                    JSON.stringify({
                        peakRssMB: +(peakRss / 1024 / 1024).toFixed(2),
                        peakHeapUsedMB: +(peakHeapUsed / 1024 / 1024).toFixed(2),
                        durationMs: +durationMs.toFixed(2),
                    })
            );
        }
    };
}

module.exports = { withMemProfiler };
