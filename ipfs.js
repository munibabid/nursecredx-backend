const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

/**
 * Upload a JSON object to IPFS using either web3.storage or Pinata.
 * The upload service is selected based on available environment variables.
 *
 * - If WEB3_STORAGE_TOKEN is defined, the object is uploaded to web3.storage.
 * - Otherwise, if PINATA_JWT is defined, the object is uploaded to Pinata.
 * - If neither token is defined, an error is thrown.
 *
 * @param {Object} obj The JSON-serializable object to upload.
 * @returns {Promise<string>} A URI of the form ipfs://<CID>
 */
async function uploadJSONToIPFS(obj) {
  const body = JSON.stringify(obj);
  // Use web3.storage if token present
  if (process.env.WEB3_STORAGE_TOKEN) {
    const resp = await fetch('https://api.web3.storage/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WEB3_STORAGE_TOKEN}`,
      },
      body,
    });
    if (!resp.ok) {
      throw new Error(`web3.storage upload failed with status ${resp.status}`);
    }
    const data = await resp.json();
    // expect { cid: '...' }
    return `ipfs://${data.cid}`;
  }
  // Fallback to Pinata if token present
  if (process.env.PINATA_JWT) {
    const resp = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PINATA_JWT}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (!resp.ok) {
      throw new Error(`pinata upload failed with status ${resp.status}`);
    }
    const data = await resp.json();
    // expect { IpfsHash: '...' }
    return `ipfs://${data.IpfsHash}`;
  }
  throw new Error('No IPFS upload token configured');
}

module.exports = { uploadJSONToIPFS };
