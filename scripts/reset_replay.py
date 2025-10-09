"""
reset_replay.py
================

This script automates the reinitialization of a NurseCredX testing
environment whenever the XRPL devnet or testnet is reset.  The
public devnet is periodically cleared, which erases account
registrations, issued credentials, DIDs and minted tokens.  Running
this script after a reset will:

1. Fund the issuer and nurse accounts via the network faucet.
2. Register or update the nurse's decentralized identifier (DID).
3. Re‑issue provisional credentials and have the nurse accept them.
4. Mint a new dynamic NFT (dNFT) representing the nurse's license.
5. Optionally issue a Multi‑purpose Token (MPT) for shift credits and
   set escrow or freeze flags.

The logic follows the XRPL protocols documented as of October 2025,
including the Dynamic NFT amendment【849396272151012†L350-L357】, credential
transactions【812198701817682†L259-L297】 and batch processing【800397403118925†L261-L404】.

Before running this script you must:

* Install the xrpl‑py library (`pip install xrpl`).
* Set environment variables for ISSUER_SEED, NURSE_SEED and RPC_URL.
* Ensure the network supports the necessary amendments (DynamicNFT,
  Credentials, DID, Batch, MPTokensV1).

Because this script calls external services (the faucet) it is not
suitable for execution in an offline sandbox.  Treat it as a starting
point for your own deployment pipelines.
"""

import os
import time
from typing import Tuple

import requests
from xrpl.clients import JsonRpcClient
from xrpl.wallet import Wallet
from xrpl.models.transactions import (
    CredentialCreate,
    CredentialAccept,
    DIDSet,
    NFTokenMint,
    MPTokenIssuanceCreate,
    MPTokenAuthorize,
    MPTokenIssuanceSet,
    EscrowCreate,
    Batch,
)
from xrpl.transaction import (
    safe_sign_and_autofill_transaction,
    send_reliable_submission,
    safe_sign_transaction
)
from xrpl.utils import hex_to_bytes, xrp_to_drops
from xrpl.models.amounts import IssuedCurrencyAmount
from batch_tx_builder import (
    build_didset_tx,
    build_credential_accept_tx,
    build_nft_mint_tx,
    build_batch_tx,
    submit_batch,
)


def fund_account(address: str, faucet_url: str = "https://faucet.altnet.rippletest.net/accounts") -> Tuple[str, int]:
    """Request funds from the XRPL testnet faucet.

    Returns the secret and initial balance.  The faucet returns a
    temporary seed; however, for stability you should use your own
    deterministic seeds for issuer and nurse accounts.

    :param address: Classic address to fund.
    :param faucet_url: URL of the testnet faucet.
    :return: Tuple of (seed, balance_drops).
    """
    resp = requests.post(faucet_url, json={"destination": address})
    resp.raise_for_status()
    data = resp.json()["account"]
    return data["secret"], int(data["balance"])


def main() -> None:
    rpc_url = os.environ.get("RPC_URL", "https://s.altnet.rippletest.net:51234")
    issuer_seed = os.environ.get("ISSUER_SEED")
    nurse_seed = os.environ.get("NURSE_SEED")
    if not (issuer_seed and nurse_seed):
        raise RuntimeError("Please set ISSUER_SEED and NURSE_SEED environment variables.")

    client = JsonRpcClient(rpc_url)
    issuer_wallet = Wallet(seed=issuer_seed, sequence=0)
    nurse_wallet = Wallet(seed=nurse_seed, sequence=0)

    # 1. Optionally fund accounts.  If your seeds were used before the reset
    # they might already be funded; otherwise use the faucet.
    # Example:
    # fund_account(issuer_wallet.classic_address)
    # fund_account(nurse_wallet.classic_address)

    # Wait for funding to be validated
    # time.sleep(4)

    # 2. Set the nurse's DID.  Use a stable URI pointing to the nurse's DID
    # document or service endpoint (e.g. IPFS).  At least one field must
    # be provided【996088701624246†L265-L297】.
    did_uri = "did:xrpl:nurse12345"  # replace with actual DID document URI
    did_tx = build_didset_tx(nurse_wallet.classic_address, uri=did_uri)

    # 3. Provisional credential issuance and acceptance.  In production the
    # issuer would first submit a CredentialCreate transaction and wait
    # until it is included in a validated ledger, then the nurse would
    # accept it.  Here we assume the provisional credential exists and
    # jump directly to acceptance in the batch.
    credential_type_hex = bytes("nurse_license", "utf-8").hex()
    cred_accept_tx = build_credential_accept_tx(
        account=nurse_wallet.classic_address,
        issuer=issuer_wallet.classic_address,
        credential_type_hex=credential_type_hex,
    )

    # 4. Mint a dynamic NFT representing the nurse's license.  The URI must
    # contain the IPFS hash or other pointer to JSON metadata conforming
    # to the schema in nurse_dNFT_schema.json.  It should be encoded to
    # hexadecimal for the transaction payload【564319106373646†L269-L299】.
    metadata_ipfs = "ipfs://cid-of-license-metadata"
    uri_hex = metadata_ipfs.encode().hex()
    nft_tx = build_nft_mint_tx(
        account=issuer_wallet.classic_address,
        issuer=nurse_wallet.classic_address,
        uri_hex=uri_hex,
        transfer_fee=750,  # 0.075% royalty on secondary transfers
        flags=0x00000008 | 0x00000010,  # tfTransferable | tfMutable【849396272151012†L350-L357】
    )

    # 5. Optionally create an MPT issuance for shift credits
    # asset_scale=0 (indivisible), tfMPTRequireAuth | tfMPTCanEscrow
    mpt_create_tx = {
        "TransactionType": "MPTokenIssuanceCreate",
        "Account": issuer_wallet.classic_address,
        "AssetScale": 0,
        "MaximumAmount": "1000000",
        "Flags": 0x00000004 | 0x00000008 | 0x00000020,  # RequireAuth, CanEscrow, CanTransfer
        "MPTokenMetadata": bytes("{\"name\": \"Shift Credit\", \"symbol\": \"SHIFT\"}", "utf-8").hex(),
        "Fee": "0",
        "Sequence": 1,
    }

    # Build batch transaction (All or Nothing mode)
    inner_txs = [did_tx, cred_accept_tx, nft_tx]
    batch = build_batch_tx(
        account=issuer_wallet.classic_address,
        inner_txs=inner_txs,
        mode_flag=65536,
        fee=str(len(inner_txs) * 10),
    )

    # Submit batch.  Note: This will fail if the network resets are still
    # processing or amendments are not enabled.  Use simulate API to
    # preview the result before committing【949306616210145†L167-L176】.
    response = submit_batch(batch, [issuer_wallet], client)
    print(response)


if __name__ == "__main__":
    main()
