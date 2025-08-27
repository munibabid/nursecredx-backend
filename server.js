require('dotenv').config();
const express = require('express');
const cors = require('cors');
const xrpl = require('xrpl');
const QRCode = require('qrcode');
const { uploadJSONToIPFS } = require('./ipfs');

const app = express();
app.use(express.json());
app.use(cors());

// Middleware to require API key if set
function requireApiKey(req, res, next) {
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const provided = req.headers['x-api-key'];
    if (!provided || provided !== apiKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  next();
}

// Connect to XRPL network
async function connectClient() {
  const client = new xrpl.Client(process.env.XRPL_NETWORK);
  await client.connect();
  return client;
}

// Mint endpoint
app.post('/mint', requireApiKey, async (req, res) => {
  const { uri, transferFee = process.env.DEFAULT_TRANSFER_FEE ? parseInt(process.env.DEFAULT_TRANSFER_FEE) : 0, taxon = 0, flags = 8 } = req.body;
  try {
    const client = await connectClient();
    const wallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SEED);
    const transaction = {
      TransactionType: 'NFTokenMint',
      Account: wallet.classicAddress,
      URI: xrpl.convertStringToHex(uri),
      Flags: flags,
      TransferFee: transferFee,
      NFTokenTaxon: taxon,
    };
    const tx = await client.submitAndWait(transaction, { wallet });
    const nfts = await client.request({ method: 'account_nfts', account: wallet.classicAddress });
    await client.disconnect();
    res.json({ result: tx.result, nfts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List NFTs
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

// Burn NFT
app.post('/burn', requireApiKey, async (req, res) => {
  const { tokenId } = req.body;
  try {
    const client = await connectClient();
    const wallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SEED);
    const tx = {
      TransactionType: 'NFTokenBurn',
      Account: wallet.classicAddress,
      NFTokenID: tokenId,
    };
    const result = await client.submitAndWait(tx, { wallet });
    const nfts = await client.request({ method: 'account_nfts', account: wallet.classicAddress });
    await client.disconnect();
    res.json({ result: result.result, nfts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Metadata endpoint
app.post('/metadata', requireApiKey, async (req, res) => {
  try {
    const { nurseId, issuedTo, licenses = [], certs = [], extras = {} } = req.body;
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

// Update URI endpoint (set new metadata)
app.post('/update-uri', requireApiKey, async (req, res) => {
  const { tokenId, newPayload } = req.body;
  try {
    const client = await connectClient();
    const wallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SEED);
    const uri = await uploadJSONToIPFS(newPayload);
    const tx = {
      TransactionType: 'NFTokenSetURI',
      Account: wallet.classicAddress,
      NFTokenID: tokenId,
      URI: xrpl.convertStringToHex(uri),
    };
    const result = await client.submitAndWait(tx, { wallet });
    await client.disconnect();
    res.json({ result: result.result, newUri: uri });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Verify token
app.get('/verify/:tokenId', async (req, res) => {
  const { tokenId } = req.params;
  try {
    const client = await connectClient();
    const wallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SEED);
    let nftInfo;
    // try nft_info
    try {
      const info = await client.request({ method: 'nft_info', nft_id: tokenId });
      nftInfo = info.result;
    } catch (err) {
      // fallback to account_nfts
      const { result } = await client.request({ method: 'account_nfts', account: wallet.classicAddress });
      nftInfo = result.account_nfts.find(n => n.NFTokenID === tokenId);
    }
    if (!nftInfo) {
      await client.disconnect();
      return res.status(404).json({ error: 'NFT not found' });
    }
    const hexUri = nftInfo.uri || nftInfo.URI || '';
    const uri = hexUri ? decodeURIComponent(hexUri.replace(/(..)/g, '%$1')) : '';
    let metadata = null;
    if (uri.startsWith('data:')) {
      const base64 = uri.split(',')[1];
      metadata = JSON.parse(Buffer.from(base64, 'base64').toString());
    } else if (uri.startsWith('ipfs://')) {
      const gateway = 'https://ipfs.io/ipfs/';
      const cid = uri.replace('ipfs://', '');
      const resp = await fetch(gateway + cid);
      if (resp.ok) {
        metadata = await resp.json().catch(() => null);
      }
    } else if (uri.startsWith('http')) {
      const resp = await fetch(uri);
      if (resp.ok) {
        metadata = await resp.json().catch(() => null);
      }
    }
    await client.disconnect();
    res.json({ tokenId, owner: nftInfo.owner, uri, metadata });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate QR code
app.get('/qr/:tokenId', async (req, res) => {
  const { tokenId } = req.params;
  try {
    const baseUrl = process.env.VERIFY_BASE || `${req.protocol}://${req.get('host')}`;
    const url = `${baseUrl}/nft/${tokenId}`;
    const qrDataUrl = await QRCode.toDataURL(url);
    const buffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
