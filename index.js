require('dotenv').config();
const express = require('express');
const cors = require('cors');
const xrpl = require('xrpl');

const app = express();
app.use(express.json());
app.use(cors());

async function connectClient() {
  const client = new xrpl.Client(process.env.XRPL_NETWORK);
  await client.connect();
  return client;
}

app.post('/mint', async (req, res) => {
  const { uri, transferFee = 0, taxon = 0, flags = 8 } = req.body;
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
