const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs/promises');

const app = express();
const PORT = process.env.PORT || 3000;
const HELIUS_RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=bdafb51b-3059-4f6e-a2a3-5b4669dc5937';
const SOLANA_CHAIN = 'solana';
const TOKENLIST_DIR = path.join(__dirname, 'tokenlists');

// Enable CORS for all routes
app.use(cors());

// Add cache headers for static assets
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 hours
  next();
});

// Serve static files from the root directory
app.use(express.static('.', {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Set content type for JSON files
    if (filePath.endsWith('.json')) {
      res.setHeader('Content-Type', 'application/json');
    }
    // Set content type for PNG files
    if (filePath.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
    }
    // Set content type for SVG files
    if (filePath.endsWith('.svg')) {
      res.setHeader('Content-Type', 'image/svg+xml');
    }
  }
}));

async function loadTokenList(chain) {
  const tokenListPath = path.join(TOKENLIST_DIR, `${chain}.json`);
  try {
    const fileContents = await fs.readFile(tokenListPath, 'utf-8');
    const parsed = JSON.parse(fileContents);
    return Array.isArray(parsed.assets) ? parsed.assets : [];
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function findAssetInList(assets, chain, tokenId) {
  if (!assets) {
    return null;
  }
  const target = typeof tokenId === 'string' ? tokenId : String(tokenId);
  return assets.find((asset) => {
    if (!asset || !asset.tokenId) {
      return false;
    }
    if (chain === SOLANA_CHAIN) {
      return asset.tokenId === target;
    }
    return asset.tokenId.toLowerCase() === target.toLowerCase();
  }) || null;
}

async function fetchHeliusMetadata(mintAddress) {
  try {
    const response = await fetch(HELIUS_RPC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `helius-${mintAddress}`,
        method: 'getAsset',
        params: {
          id: mintAddress,
          displayOptions: {
            showFungible: true
          }
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Helius responded with status ${response.status}`);
    }

    const payload = await response.json();
    if (!payload || payload.error || !payload.result) {
      return null;
    }

    return payload.result;
  } catch (err) {
    console.error(`Helius metadata fetch failed for ${mintAddress}:`, err.message);
    return null;
  }
}

function mapHeliusAssetToResponse(mintAddress, heliusAsset) {
  if (!heliusAsset || heliusAsset.interface !== 'FungibleToken') {
    return null;
  }

  const metadata = heliusAsset.content?.metadata || {};
  const tokenInfo = heliusAsset.token_info || {};
  const logoURI = heliusAsset.content?.links?.image
    || heliusAsset.content?.files?.[0]?.uri
    || null;
  const supply = tokenInfo.supply === undefined || tokenInfo.supply === null
    ? null
    : tokenInfo.supply.toString();

  return {
    chain: SOLANA_CHAIN,
    tokenId: mintAddress,
    name: metadata.name || tokenInfo.name || mintAddress,
    symbol: metadata.symbol || tokenInfo.symbol || '',
    type: 'SPL',
    decimals: typeof tokenInfo.decimals === 'number' ? tokenInfo.decimals : 0,
    logoURI,
    supply
  };
}

app.get('/api/assets/:chain/:tokenId', async (req, res) => {
  const chain = req.params.chain.toLowerCase();
  const { tokenId } = req.params;

  try {
    const assets = await loadTokenList(chain);
    const asset = findAssetInList(assets, chain, tokenId);
    if (asset) {
      return res.json(asset);
    }

    if (chain === SOLANA_CHAIN) {
      const heliusAsset = await fetchHeliusMetadata(tokenId);
      const mappedAsset = mapHeliusAssetToResponse(tokenId, heliusAsset);
      if (mappedAsset) {
        return res.json(mappedAsset);
      }
    }

    return res.status(404).json({ error: 'Asset not found' });
  } catch (err) {
    console.error('Asset lookup failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Asset not found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Assets server running on port ${PORT}`);
});

