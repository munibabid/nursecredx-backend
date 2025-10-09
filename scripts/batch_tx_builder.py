"""
batch_tx_builder.py
====================

This module provides helper functions to build and optionally submit
multi step onboarding transactions for the NurseCredX platform on the XRP Ledger.

The XRP Ledger added support for atomic batch transactions (XLS‑56) in 2025. A
batch can contain up to eight unsigned inner transactions that are all
executed together.  If any inner transaction fails, the whole batch fails
depending on the batch mode.  This allows developers to combine
decentralized identifier (DID) setup, credential acceptance and dynamic
NFT minting in a single atomic unit.

The functions in this file use the `xrpl‑py` client library to assemble
transactions.  To actually submit them to a network you must provide a
funded account and network URL.  The code is written against the XRPL
protocol as of October 2025.

Important protocol details used here include:

* The Dynamic NFT amendment introduced the `tfMutable` flag (decimal value
  `16`) so that the URI of a minted token can be updated later using the
  `NFTokenModify` transaction【849396272151012†L350-L357】.

* The Batch transaction type encapsulates a list of inner transactions in
  the `RawTransactions` field and requires a batch mode flag (for
  example, `tfBatchAllOrNothing`, decimal `65536`)【800397403118925†L261-L404】.

* `CredentialAccept` must be signed by the subject of the credential
  (the nurse) and accepts a provisional credential issued by the
  regulator【812198701817682†L259-L297】.

* `DIDSet` associates a decentralized identifier or DID document with an
  account.  At least one of `URI`, `Data` or `DIDDocument` must be
  provided【996088701624246†L265-L297】.

Because dynamic NFT minting, credential acceptance and DID creation
require separate signatures, this sample assumes that you control the
private keys for both the issuer and the nurse accounts.  In a
production environment you would coordinate with the nurse to sign
their portion.

Usage Example
-------------

```python
from xrpl.wallet import Wallet
from batch_tx_builder import (
    build_didset_tx,
    build_credential_accept_tx,
    build_nft_mint_tx,
    build_batch_tx,
    submit_batch
)

# Configuration
RPC_URL = "https://s.altnet.rippletest.net:51234"  # XRPL testnet JSON‑RPC
issuer_wallet = Wallet(seed="s████████████████████████████", sequence=1)
nurse_wallet  = Wallet(seed="s████████████████████████████", sequence=1)

# Build inner transactions
did_tx  = build_didset_tx(nurse_wallet.classic_address, uri="ipfs://…", fee="0")
cred_tx = build_credential_accept_tx(
    account=nurse_wallet.classic_address,
    issuer=issuer_wallet.classic_address,
    credential_type_hex="6e757273655f6c6963656e7365",  # 'nurse_license' hex
    fee="0"
)
nft_tx  = build_nft_mint_tx(
    account=issuer_wallet.classic_address,
    issuer=nurse_wallet.classic_address,
    uri_hex="69706673…",  # hex‑encoded metadata URI
    transfer_fee=750,      # optional royalty (0.075%)
    flags=0x00000008 | 0x00000010,  # tfTransferable | tfMutable
    fee="0"
)

batch_tx = build_batch_tx(
    account=issuer_wallet.classic_address,
    inner_txs=[did_tx, cred_tx, nft_tx],
    mode_flag=65536,  # All or Nothing
    fee=str(len(inner_txs) * 10)  # pay minimal fee once
)

# Submit
client = JsonRpcClient(RPC_URL)
result = submit_batch(batch_tx, [issuer_wallet, nurse_wallet], client)
print(result)
```

Note: The `xrpl‑py` library may not be installed in this environment.  You
should install it via pip (`pip install xrpl`) and ensure your accounts
have sufficient XRP to cover reserve and fee requirements.
"""

from dataclasses import dataclass
from typing import List, Optional

try:
    from xrpl.models.transactions import (
        Batch,
        NFTokenMint,
        CredentialAccept,
        DIDSet,
        NFTokenMintFlag,
    )
    from xrpl.models.transactions import Transaction
    from xrpl.clients import JsonRpcClient
    from xrpl.transaction import (safe_sign_transaction, send_reliable_submission)
    from xrpl.wallet import Wallet
    from xrpl.utils import xrp_to_drops
except ImportError:
    # Provide stub types if xrpl is not available.  This allows the file
    # to be imported for static analysis and documentation without
    # executing any network logic.  When running in production, ensure
    # xrpl‑py is installed.
    Batch = object
    NFTokenMint = object
    CredentialAccept = object
    DIDSet = object
    Transaction = object
    JsonRpcClient = object
    Wallet = object
    NFTokenMintFlag = object
    def safe_sign_transaction(*args, **kwargs):
        raise RuntimeError("xrpl‑py is not available; install xrpl to use this function.")
    def send_reliable_submission(*args, **kwargs):
        raise RuntimeError("xrpl‑py is not available; install xrpl to use this function.")
    def xrp_to_drops(x):
        # simple conversion fallback
        return str(int(float(x) * 1_000_000))


def build_didset_tx(account: str, *, uri: Optional[str] = None,
                    data: Optional[str] = None,
                    did_document: Optional[str] = None,
                    fee: str = "0") -> dict:
    """Create an unsigned DIDSet transaction dictionary.

    At least one of `uri`, `data`, or `did_document` must be provided.  The
    fee is expressed in drops.  Setting fee to "0" is acceptable for inner
    transactions of a batch【800397403118925†L390-L403】.

    :param account: Classic address of the account whose DID is being set.
    :param uri: URI associated with the DID (e.g. IPFS link to DID
        document or service endpoint).
    :param data: Optional base64‑encoded data payload.
    :param did_document: Optional DID document as a base64‑encoded
        string.
    :param fee: Fee in drops; use "0" when this transaction is part of a
        Batch.
    :return: JSON dictionary representing the transaction.
    """
    tx: dict = {
        "TransactionType": "DIDSet",
        "Account": account,
        "Fee": fee,
        # Note: Sequence is omitted for inner batch transactions.
        "Flags": 0,
    }
    if uri:
        from binascii import hexlify
        tx["URI"] = hexlify(uri.encode()).decode()
    if data:
        from binascii import hexlify
        tx["Data"] = hexlify(data.encode()).decode()
    if did_document:
        from binascii import hexlify
        tx["DIDDocument"] = hexlify(did_document.encode()).decode()
    return tx


def build_credential_accept_tx(account: str, issuer: str,
                               credential_type_hex: str,
                               *, fee: str = "0") -> dict:
    """Create an unsigned CredentialAccept transaction dictionary.

    The account must be the subject of the credential (nurse).  The
    credential_type_hex should be a hex‑encoded identifier matching the
    provisional credential created by the issuer【812198701817682†L259-L297】.

    :param account: Classic address of the subject accepting the credential.
    :param issuer: Classic address of the issuer who created the credential.
    :param credential_type_hex: Hexadecimal blob identifying the credential type.
    :param fee: Fee in drops; use "0" for inner batch transactions.
    :return: JSON dictionary representing the transaction.
    """
    return {
        "TransactionType": "CredentialAccept",
        "Account": account,
        "Issuer": issuer,
        "CredentialType": credential_type_hex,
        "Fee": fee,
        "Flags": 0,
    }


def build_nft_mint_tx(account: str, *, issuer: Optional[str] = None,
                       uri_hex: str, transfer_fee: Optional[int] = None,
                       taxon: int = 0, flags: int = 0,
                       fee: str = "0") -> dict:
    """Create an unsigned NFTokenMint transaction dictionary.

    To make the NFT mutable, include the `tfMutable` flag (`16`) in the
    flags parameter.  To allow transfers, include `tfTransferable` (`8`)【849396272151012†L350-L357】.

    :param account: Account funding the mint (minter or authorized minter).
    :param issuer: Optional issuer field; set to the nurse's account if minting on their behalf.
    :param uri_hex: Hexadecimal string representing the token's metadata URI.
    :param transfer_fee: Optional royalty fee in basis points (1/10000 of a percent).  Must be between 0 and 50000.
    :param taxon: Arbitrary 32‑bit integer used to group NFTs; default 0.
    :param flags: Bitwise OR of NFTokenMint flags.  Use 0x00000010 for mutable and 0x00000008 for transferable.
    :param fee: Fee in drops; use "0" when used inside a Batch.
    :return: JSON dictionary representing the transaction.
    """
    tx = {
        "TransactionType": "NFTokenMint",
        "Account": account,
        "NFTokenTaxon": taxon,
        "Fee": fee,
        "Flags": flags,
        "URI": uri_hex,
    }
    if issuer:
        tx["Issuer"] = issuer
    if transfer_fee is not None:
        tx["TransferFee"] = transfer_fee
    return tx


def build_batch_tx(account: str, inner_txs: List[dict], mode_flag: int,
                   *, fee: str) -> dict:
    """Wrap a list of unsigned transactions into a Batch transaction.

    Each inner transaction must include the `tfInnerBatchTxn` flag (0x40000000)
    and have its `Fee` set to "0"【800397403118925†L398-L403】.  This helper adds
    the inner flag automatically if not present.

    The outer batch must specify exactly one batch mode flag.  Use
    65536 (`0x00010000`) for All or Nothing, 131072 (`0x00020000`) for
    Only One, 262144 (`0x00040000`) for Until Failure, or 524288
    (`0x00080000`) for Independent.

    :param account: Address paying the batch fee (issuer for onboarding flows).
    :param inner_txs: List of unsigned transaction dictionaries.
    :param mode_flag: Flag indicating the batch execution mode.
    :param fee: Fee in drops for the outer Batch transaction.
    :return: JSON dictionary representing the Batch transaction.
    """
    inner_list = []
    for tx in inner_txs:
        # Ensure each inner transaction has tfInnerBatchTxn flag
        # Decimal 1073741824 = 0x40000000
        inner_flags = tx.get("Flags", 0)
        if not (inner_flags & 0x40000000):
            tx["Flags"] = inner_flags | 0x40000000
        # Sequence is required; set dummy value of 1 for each.  The XRPL
        # server will correct these when simulating or submitting the batch.
        tx.setdefault("Sequence", 1)
        # Ensure fee is zero
        tx["Fee"] = "0"
        inner_list.append({"RawTransaction": tx})
    batch_tx = {
        "TransactionType": "Batch",
        "Account": account,
        "Flags": mode_flag,
        "RawTransactions": inner_list,
        "Fee": fee,
    }
    return batch_tx


def sign_batch(batch_tx: dict, wallets: List[Wallet], client: JsonRpcClient) -> Transaction:
    """Sign a Batch transaction with one or more wallets.

    For multi‑account batches, a `BatchSigners` field must be included.  This
    helper currently supports only single‑account batches where the outer
    Account matches the payer's wallet.  If multiple inner transactions are
    from different accounts (e.g. nurse and issuer), you must assemble
    `BatchSigners` yourself.  See XRPL documentation for details【800397403118925†L358-L376】.

    :param batch_tx: Unsigned batch transaction dictionary.
    :param wallets: List of xrpl Wallets whose signatures are required.  The
        first wallet in the list is assumed to be the batch payer.
    :param client: JsonRpcClient instance connected to the target network.
    :return: A signed Transaction instance ready to be submitted.
    """
    # Fill in Sequence, Fee, and other defaults
    from xrpl.transaction import safe_sign_and_autofill_transaction
    from xrpl.models import Transaction

    # Convert to Transaction object
    import xrpl
    tx_obj: Transaction = xrpl.models.transactions.transaction_from_dict(batch_tx)
    # Sign with the first wallet
    signed = safe_sign_and_autofill_transaction(tx_obj, wallets[0], client)
    return signed


def submit_batch(batch_tx: dict, wallets: List[Wallet], client: JsonRpcClient) -> dict:
    """Sign and submit a batch transaction.

    :param batch_tx: Unsigned batch transaction dictionary.
    :param wallets: Wallets to sign with.  The first wallet should be the
        payer for the outer Batch transaction.  Additional wallets are
        ignored for simple single‑account batches.
    :param client: Connected JSON‑RPC client.
    :return: Result dictionary from XRPL server.
    """
    signed_tx = sign_batch(batch_tx, wallets, client)
    response = send_reliable_submission(signed_tx, client)
    return response
