require('dotenv').config();
const express = require('express');
const cors = require('cors');
const xrpl = require('xrpl');
const QRCode = require('qrcode');
const { uploadJSONToIPFS } = require('./ipfs');

const app = express();
app.use(express.json());
app.use(cors());

function requireApiKey(req, res, next) {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
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
  const { uri, transferFee, taxon = 0, flags = 8 } = req.body;
  const fee = transferFee !== undefined ? transferFee : (process.env.DEFAULT_TRANSFER_FEE ? parseInt(process.env.DEFAULT_TRANSFER_FEE) : 0);
  try {
    const client = await connectClient();
    const wallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SEED);
    const tx = {
      TransactionType: 'NFTokenMint',
      Account: wallet.classicAddress,
      URI: uri ? xrpl.convertStringToHex(uri) : undefined,
      Flags: flags,
      TransferFee: fee,
      NFTokenTaxon: taxon
    };
    const result = await client.submitAndWait(tx, { wallet });
    const nfts = await client.request({ method: 'account_nfts', account: wallet.classicAddress });
    await client.disconnect();
    res.json({ result: result.result, nfts });
  } catch (e) {
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

app.post('/burn', requireApiKey, async (req, res) => {
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
      ...extras
    };
    const uri = await uploadJSONToIPFS(payload);
    res.json({ uri, payload });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/update-uri', requireApiKey, async (req, res) => {
  const { tokenId, newPayload } = req.body;
  if (!tokenId || !newPayload) {
    return res.status(400).json({ error: 'tokenId and newPayload are required' });
  }
  try {
    const newUri = await uploadJSONToIPFS(newPayload);
    const client = await connectClient();
    const wallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SEED);
    const tx = {
      TransactionType: 'NFTokenSetURI',
      Account: wallet.classicAddress,
      NFTokenID: tokenId,
      URI: xrpl.convertStringToHex(newUri)
    };
    const result = await client.submitAndWait(tx, { wallet });
    await client.disconnect();
    res.json({ ok: true, newUri, result: result.result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/verify/:tokenId', async (req, res) => {
  const { tokenId } = req.params;
  try {
    const client = await connectClient();
    const wallet = xrpl.Wallet.fromSeed(process.env.ISSUER_SEED);
    let nftInfo;
    try {
      const info = await client.request({ method: 'nft_info', nft_id: tokenId });
      nftInfo = info.result;
    } catch (err) {
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
      try {
        const resp = await fetch(gateway + cid);
        if (resp.ok) {
          metadata = await resp.json();
        }
      } catch (err) {
        // ignore
      }
    }
    await client.disconnect();
    res.json({ tokenId, owner: nftInfo.owner, uri, metadata });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/qr/:tokenId', async (req, res) => {
  const { tokenId } = req.params;
  try {
    const base = process.env.VERIFY_BASE || `${req.protocol}://${req.get('host')}/nft`;
    const url = `${base}/${tokenId}`;
    const qrDataUrl = await QRCode.toDataURL(url);
    const img = Buffer.from(qrDataUrl.split(',')[1], 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.send(img);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
