require('dotenv').config();
const express = require('express');
const cors = require('cors');
const xrpl = require('xrpl');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { uploadJSONToIPFS } = require('./ipfs');

const app = express();
app.use(express.json());
app.use(cors());

// Middleware to enforce API key authentication for paid or premium endpoints.
// If an API_KEY environment variable is defined, incoming requests must
// include a matching key in the 'x-api-key' header. Endpoints that do not
// call this middleware remain publicly accessible. This simple check
// simulates a paywall or subscription model without integrating with a
// payment processor.
function requireApiKey(req, res, next) {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    // No API_KEY configured, skip validation
    return next();
  }
  const supplied = req.headers['x-api-key'];
  if (!supplied || supplied !== apiKey) {
    return res.status(403).json({ error: 'Forbidden: invalid API key' });
  }
  next();
}

async function connectClient() {
  const client = new xrpl.Client(process.env.XRPL_NETWORK);
  await client.connect();
  return client;
}

app.post('/mint', requireApiKey, async (req, res) => {
    const { uri, transferFee = process.env.DEFAULT_TRANSFER_FEE ? parseInt(process.env.DEFAULT_TRANSFER_FEE) : 0, taxon = 0, flags = 8 } = req.body;
  try {
    const client = await connectClient();
    const wallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SEED);
    const tx = {
      TransactionType: 'NFTokenMint',
      Account: wallet.classicAddress,
      URI: xrpl.convertStringToHex(uri),
      Flags: flags,
      TransferFee: transferFee,
      NFTokenTaxon: taxon
    };
    const result = await client.submitAndWait(tx, { wallet });
    const nfts = await client.request({ method: 'account_nfts', account: wallet.classicAddress });
    await client.disconnect();
    res.json({ result: result.result, nfts });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/nfts', async (req, res) => {
  try {
    const client = await connectClient();
    const wallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SEED);
    const nfts = await client.request({ method: 'account_nfts', account: wallet.classicAddress });
    await client.disconnect();
    res.json(nfts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/burn', async (req, res) => {
  const { tokenId } = req.body;
  try {
    const client = await connectClient();
    const wallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SEED);
    const tx = {
      TransactionType: 'NFTokenBurn',
      Account: wallet.classicAddress,
      NFTokenID: tokenId
    };
    const result = await client.submitAndWait(tx, { wallet });
    const nfts = await client.request({ method: 'account_nfts', account: wallet.classicAddress });
    await client.disconnect();
    res.json({ result: result.result, nfts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Verify an NFT by checking if the token ID exists in the issuer's account.
// Returns metadata about the token if found, otherwise a 404.
app.get('/verify/:tokenId', async (req, res) => {
  const { tokenId } = req.params;
  try {
    const client = await connectClient();
    // Use NFT info call directly
    const info = await client.request({ command: 'nft_info', nft_id: tokenId }).catch(() => null);
    await client.disconnect();
    if (!info || !info.result) {
      return res.status(404).json({ error: 'NFT not found' });
    }
    const nft = info.result;
    // decode URI from hex to string
    const uriHex = nft.uri || nft.URI || '';
    const uri = uriHex ? decodeURIComponent(uriHex.replace(/(..)/g, '%$1')) : '';
    let metadata = null;
    // attempt to fetch metadata if URI uses ipfs:// or http(s)
    if (uri) {
      try {
        if (uri.startsWith('ipfs://')) {
          const cid = uri.replace('ipfs://', '');
          const gateway = 'https://ipfs.io/ipfs/';
          const resp = await fetch(gateway + cid);
          if (resp.ok) {
            metadata = await resp.json();
          }
        } else if (uri.startsWith('http://') || uri.startsWith('https://')) {
          const resp = await fetch(uri);
          if (resp.ok) {
            metadata = await resp.json().catch(() => null);
          }
        }
      } catch (_) {
        metadata = null;
      }
    }
    return res.json({
      tokenId,
      owner: nft.owner,
      uri,
      metadata,
      status: metadata ? 'VALID' : 'URI_UNREADABLE',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate a QR code PNG for a given NFTokenID. The QR code encodes a URL
// pointing back to the verification endpoint for this token. Clients can
// scan the QR code to verify the credential. If the token is not found
// the code still encodes the verification URL. Requires the qrcode
// package to be installed.
const QRCode = require('qrcode');

app.get('/qr/:tokenId', async (req, res) => {
  const { tokenId } = req.params;
  try {
    // Construct verification URL based on current server host if possible
    // Fall back to environment variable or relative path
    // Prefer VERIFY_BASE (Netlify verify site) if defined
    const baseUrl = process.env.VERIFY_BASE || process.env.VERIFICATION_BASE_URL || `${req.protocol}://${req.get('host')}`;
    // Remove trailing slash from base URL if present
    const verifyBase = baseUrl.replace(/\/$/, '');
    const verifyUrl = `${verifyBase}/nft/${tokenId}`;
    const qrDataUrl = await QRCode.toDataURL(verifyUrl);
    const img = Buffer.from(qrDataUrl.split(',')[1], 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.send(img);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint to create RN metadata and upload it to IPFS. Requires API key.
app.post('/metadata', requireApiKey, async (req, res) => {
  try {
    const { nurseId, issuedTo, licenses = [], certs = [], ...extras } = req.body;
    if (!nurseId || !issuedTo) {
      return res.status(400).json({ error: 'nurseId and issuedTo are required' });
    }
    const payload = {
      nurseId,
      issuedTo,
      licenses,
      certs,
      verifier: 'NursecredX',
      version: '1.0.0',
      lastChecked: new Date().toISOString(),
      ...extras,
    };
    const uri = await uploadJSONToIPFS(payload);
    res.json({ uri, payload });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint to update an existing NFT's URI by uploading new metadata and setting it on chain.
// This uses NFTokenSetURI, which may not be supported on some XRPL versions. If unsupported, mint a new token instead.
app.post('/update-uri', requireApiKey, async (req, res) => {
  const { tokenId, nurseId, issuedTo, licenses = [], certs = [], version = '1.0.0', ...extras } = req.body;
  try {
    if (!tokenId || !nurseId || !issuedTo) {
      return res.status(400).json({ error: 'tokenId, nurseId and issuedTo are required' });
    }
    const payload = {
      nurseId,
      issuedTo,
      licenses,
      certs,
      verifier: 'NursecredX',
      version,
      lastChecked: new Date().toISOString(),
      ...extras,
    };
    const newUri = await uploadJSONToIPFS(payload);
    const client = await connectClient();
    const wallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SEED);
    const tx = {
      TransactionType: 'NFTokenSetURI',
      Account: wallet.classicAddress,
      NFTokenID: tokenId,
      URI: xrpl.convertStringToHex(newUri),
    };
    const result = await client.submitAndWait(tx, { wallet });
    await client.disconnect();
    res.json({ newUri, result: result.result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
