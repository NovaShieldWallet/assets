const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs/promises');

const app = express();
const PORT = process.env.PORT || 3000;
const HELIUS_RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=bdafb51b-3059-4f6e-a2a3-5b4669dc5937';
const SOLANA_CHAIN = 'solana';
const TOKENLIST_DIR = path.join(__dirname, 'tokenlists');
const BLOCKCHAINS_DIR = path.join(__dirname, 'blockchains');
const SOLANA_ASSETS_DIR = path.join(BLOCKCHAINS_DIR, SOLANA_CHAIN, 'assets');
const SOLANA_LOGO_FILENAME = 'logo.png';

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

function buildLocalSolanaLogoURI(tokenId) {
  return `/blockchains/${SOLANA_CHAIN}/assets/${tokenId}/${SOLANA_LOGO_FILENAME}`;
}

function normalizeLogoUri(uri) {
  if (!uri || typeof uri !== 'string') {
    return null;
  }
  if (uri.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}`;
  }
  if (uri.startsWith('ar://')) {
    return `https://arweave.net/${uri.slice('ar://'.length)}`;
  }
  return uri;
}

async function cacheSolanaLogo(asset) {
  const normalizedUri = normalizeLogoUri(asset.logoURI);
  if (!normalizedUri) {
    return null;
  }

  const tokenDir = path.join(SOLANA_ASSETS_DIR, asset.tokenId);
  const logoPath = path.join(tokenDir, SOLANA_LOGO_FILENAME);

  try {
    await fs.access(logoPath);
    return buildLocalSolanaLogoURI(asset.tokenId);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  await fs.mkdir(tokenDir, { recursive: true });

  if (normalizedUri.startsWith('data:')) {
    const separatorIndex = normalizedUri.indexOf(',');
    if (separatorIndex === -1) {
      return null;
    }
    const metadataSection = normalizedUri.slice(5, separatorIndex);
    const isBase64 = metadataSection.includes(';base64');
    const dataSection = normalizedUri.slice(separatorIndex + 1);
    const buffer = Buffer.from(dataSection, isBase64 ? 'base64' : 'utf-8');
    await fs.writeFile(logoPath, buffer);
    return buildLocalSolanaLogoURI(asset.tokenId);
  }

  const response = await fetch(normalizedUri);
  if (!response.ok) {
    throw new Error(`Logo download failed with status ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(logoPath, buffer);
  return buildLocalSolanaLogoURI(asset.tokenId);
}

async function readTokenListPayload(chain) {
  const tokenListPath = path.join(TOKENLIST_DIR, `${chain}.json`);
  try {
    const contents = await fs.readFile(tokenListPath, 'utf-8');
    const parsed = JSON.parse(contents);
    if (!Array.isArray(parsed.assets)) {
      parsed.assets = [];
    }
    if (typeof parsed.version !== 'number') {
      parsed.version = 1;
    }
    return { payload: parsed, tokenListPath };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        payload: { version: 1, assets: [] },
        tokenListPath
      };
    }
    throw err;
  }
}

function sanitizeAssetForTokenList(asset) {
  const base = {
    chain: SOLANA_CHAIN,
    tokenId: asset.tokenId,
    name: asset.name,
    symbol: asset.symbol,
    type: asset.type || 'SPL',
    decimals: typeof asset.decimals === 'number' ? asset.decimals : 0
  };

  if (asset.logoURI) {
    base.logoURI = asset.logoURI;
  }

  if (asset.supply) {
    base.supply = asset.supply;
  }

  return base;
}

async function upsertSolanaTokenList(asset) {
  const { payload, tokenListPath } = await readTokenListPayload(SOLANA_CHAIN);
  const assets = payload.assets;
  const existing = findAssetInList(assets, SOLANA_CHAIN, asset.tokenId);

  if (existing) {
    const sanitized = sanitizeAssetForTokenList(asset);
    let shouldPersist = false;
    Object.entries(sanitized).forEach(([key, value]) => {
      if (value === undefined) {
        return;
      }
      if (existing[key] !== value) {
        existing[key] = value;
        shouldPersist = true;
      }
    });

    if (shouldPersist) {
      await fs.writeFile(tokenListPath, `${JSON.stringify(payload, null, 4)}\n`, 'utf-8');
    }
    return;
  }

  assets.push(sanitizeAssetForTokenList(asset));
  await fs.writeFile(tokenListPath, `${JSON.stringify(payload, null, 4)}\n`, 'utf-8');
}

async function persistSolanaAsset(asset) {
  const updatedAsset = { ...asset };
  try {
    const localLogoUri = await cacheSolanaLogo(updatedAsset);
    if (localLogoUri) {
      updatedAsset.logoURI = localLogoUri;
    }
  } catch (err) {
    console.error(`Failed to cache logo for ${asset.tokenId}:`, err.message);
  }

  try {
    await upsertSolanaTokenList(updatedAsset);
  } catch (err) {
    console.error(`Failed to update Solana token list for ${asset.tokenId}:`, err.message);
  }

  return updatedAsset;
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
        const persisted = await persistSolanaAsset(mappedAsset);
        return res.json(persisted);
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

// Fallback middleware for missing static assets - fetch from Trust Wallet CDN
app.use(async (req, res, next) => {
  // Only handle requests for blockchain assets (images)
  const assetPathMatch = req.path.match(/^\/blockchains\/([^/]+)\/assets\/([^/]+)\/(logo\.(png|svg))$/);
  if (!assetPathMatch) {
    return next();
  }

  const [, chain, tokenId, filename] = assetPathMatch;
  const localPath = path.join(__dirname, req.path);

  try {
    // Check if file exists locally
    await fs.access(localPath);
    // File exists, let express.static handle it (shouldn't reach here, but just in case)
    return next();
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Unexpected error
      console.error(`Error checking local file ${localPath}:`, err);
      return next();
    }
    // File doesn't exist locally, try Trust Wallet CDN
  }

  // Try fetching from Trust Wallet CDN first
  const trustWalletUrl = `https://assets-cdn.trustwallet.com${req.path}`;
  
  try {
    console.log(`Fetching from Trust Wallet CDN: ${trustWalletUrl}`);
    const response = await fetch(trustWalletUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Assets-Server/1.0)'
      }
    });

    if (response.ok) {
      // Successfully fetched from CDN
      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || 
        (filename.endsWith('.png') ? 'image/png' : 'image/svg+xml');
      
      // Cache headers
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 hours
      res.setHeader('X-Cached-From', 'trustwallet-cdn');
      
      // Optionally cache locally for future requests (async, don't wait)
      const tokenDir = path.join(BLOCKCHAINS_DIR, chain, 'assets', tokenId);
      fs.mkdir(tokenDir, { recursive: true })
        .then(() => fs.writeFile(localPath, buffer))
        .then(() => console.log(`Cached locally: ${localPath}`))
        .catch(err => console.error(`Failed to cache locally ${localPath}:`, err.message));
      
      return res.send(buffer);
    } else {
      console.log(`Trust Wallet CDN returned ${response.status} for ${trustWalletUrl}`);
    }
  } catch (err) {
    console.error(`Error fetching from Trust Wallet CDN ${trustWalletUrl}:`, err.message);
  }

  // If Trust Wallet CDN failed, try fetching from Helius metadata for Solana tokens
  if (chain === SOLANA_CHAIN) {
    try {
      console.log(`Attempting to fetch Solana token metadata for ${tokenId}`);
      const heliusAsset = await fetchHeliusMetadata(tokenId);
      if (heliusAsset) {
        const mappedAsset = mapHeliusAssetToResponse(tokenId, heliusAsset);
        if (mappedAsset && mappedAsset.logoURI) {
          const normalizedUri = normalizeLogoUri(mappedAsset.logoURI);
          if (normalizedUri) {
            console.log(`Fetching logo from metadata URI: ${normalizedUri}`);
            const logoResponse = await fetch(normalizedUri, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Assets-Server/1.0)'
              }
            });

            if (logoResponse.ok) {
              const buffer = Buffer.from(await logoResponse.arrayBuffer());
              const contentType = logoResponse.headers.get('content-type') || 
                (filename.endsWith('.png') ? 'image/png' : 'image/svg+xml');
              
              // Cache headers
              res.setHeader('Content-Type', contentType);
              res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 hours
              res.setHeader('X-Cached-From', 'helius-metadata');
              
              // Cache locally and update token list (async, don't wait)
              const tokenDir = path.join(BLOCKCHAINS_DIR, chain, 'assets', tokenId);
              fs.mkdir(tokenDir, { recursive: true })
                .then(() => fs.writeFile(localPath, buffer))
                .then(() => {
                  console.log(`Cached locally: ${localPath}`);
                  // Update token list with the asset
                  return persistSolanaAsset(mappedAsset);
                })
                .catch(err => console.error(`Failed to cache locally ${localPath}:`, err.message));
              
              return res.send(buffer);
            } else {
              console.log(`Failed to fetch logo from metadata URI ${normalizedUri}: ${logoResponse.status}`);
            }
          }
        }
      }
    } catch (err) {
      console.error(`Error fetching from Helius metadata for ${tokenId}:`, err.message);
    }
  }

  // All fallbacks failed
  return next();
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Asset not found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Assets server running on port ${PORT}`);
});

