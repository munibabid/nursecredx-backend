require('dotenv').config();
const express = require('express');
const cors = require('cors');
const xrpl = require('xrpl');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());
app.use(cors());

// API key middleware for paid/premium endpoints
function requireApiKey(req, res, next) {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return next();
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
  const {
    uri,
    transferFee = process.env.DEFAULT_TRANSFER_FEE
      ? parseInt(process.env.DEFAULT_TRANSFER_FEE)
      : 0,
    taxon = 0,
    flags = 8,
  } = req.body;
  try {
    const client = await connectClient();
    const wallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SEED);
    const tx = {
      TransactionType: 'NFTokenMint',
      Account: wallet.classicAddress,
      URI: xrpl.convertStringToHex(uri),
      Flags: flags,
      TransferFee: transferFee,
      NFTokenTaxon: taxon,
    };
    const result = await client.submitAndWait(tx, { wallet });
    const nfts = await client.request({
      method: 'account_nfts',
      account: wallet.classicAddress,
    });
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
    const nfts = await client.request({
      method: 'account_nfts',
      account: wallet.classicAddress,
    });
    await client.disconnect();
    res.json(nfts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    const nfts = await client.request({
      method: 'account_nfts',
      account: wallet.classicAddress,
    });
    await client.disconnect();
    res.json({ result: result.result, nfts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Verify endpoint: returns NFT details or 404
app.get('/verify/:tokenId', async (req, res) => {
  const { tokenId } = req.params;
  try {
    const client = await connectClient();
    const wallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SEED);
    const { result } = await client.request({
      method: 'account_nfts',
      account: wallet.classicAddress,
    });
    const nft = result.account_nfts.find((n) => n.NFTokenID === tokenId);
    await client.disconnect();
    if (!nft) return res.status(404).json({ error: 'NFT not found' });
    const uriHex = nft.URI || '';
    const decodedUri = uriHex ? xrpl.convertHexToString(uriHex) : '';
    return res.json({ ...nft, decodedUri });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// QR code endpoint
app.get('/qr/:tokenId', async (req, res) => {
  const { tokenId } = req.params;
  try {
    const baseUrl =
      process.env.VERIFICATION_BASE_URL ||
      `${req.protocol}://${req.get('host')}`;
    const verifyUrl = `${baseUrl}/verify/${tokenId}`;
    const qrDataUrl = await QRCode.toDataURL(verifyUrl);
    const img = Buffer.from(qrDataUrl.split(',')[1], 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.send(img);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
