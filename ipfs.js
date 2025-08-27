// Use global fetch in Node 18; no need for node-fetch
async function uploadJSONToIPFS(obj) {
  const body = JSON.stringify(obj);
  // Use web3.storage if token available
  if (process.env.WEB3_STORAGE_TOKEN) {
    const resp = await fetch('https://api.web3.storage/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WEB3_STORAGE_TOKEN}`
      },
      body,
    });
    if (!resp.ok) {
      throw new Error(`web3.storage upload failed with status ${resp.status}`);
    }
    const data = await resp.json();
    return `ipfs://${data.cid}`;
  }
  // Use Pinata if token available
  if (process.env.PINATA_JWT) {
    const resp = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PINATA_JWT}`,
        'Content-Type': 'application/json'
      },
      body,
    });
    if (!resp.ok) {
      throw new Error(`Pinata upload failed with status ${resp.status}`);
    }
    const data = await resp.json();
    return `ipfs://${data.IpfsHash}`;
  }
  throw new Error('No IPFS upload token configured');
}

module.exports = { uploadJSONToIPFS };
