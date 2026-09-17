const axios = require('axios');

async function getCryptoAmounts(usdPrice) {
    try {
        const [eth, ltc, btc, sol] = await Promise.all([
            axios.get('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT'),
            axios.get('https://api.binance.com/api/v3/ticker/price?symbol=LTCUSDT'),
            axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'),
            axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT')
        ]);
        return {
            eth: (usdPrice / parseFloat(eth.data.price)).toFixed(6),
            ltc: (usdPrice / parseFloat(ltc.data.price)).toFixed(4),
            btc: (usdPrice / parseFloat(btc.data.price)).toFixed(8),
            sol: (usdPrice / parseFloat(sol.data.price)).toFixed(4)
        };
    } catch (error) {
        return { eth: 'Check live rate', ltc: 'Check live rate', btc: 'Check live rate', sol: 'Check live rate' };
    }
}

function calculatePoints(usdPrice) {
    if (usdPrice <= 0) return 0;
    if (usdPrice <= 100) return 2;
    if (usdPrice <= 500) return 4;
    if (usdPrice <= 1000) return 7;
    return 10;
}

module.exports = { getCryptoAmounts, calculatePoints };