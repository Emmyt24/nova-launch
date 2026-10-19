# Batch Transfer (#2237)

`batch_transfer(from, token, transfers: Vec<(Address, i128)>) -> u32` sends `token`
from `from` to many recipients in one transaction.

- Max batch size: 50 (`Error::BatchTooLarge` above, `Error::InvalidParameters` when empty).
- Atomic: inputs (amounts > 0, no overflow, sender balance covers the total) are validated first;
  any later failure aborts the transaction and rolls back all transfers and events.
- Events: `bt_item` per transfer (`topics: (bt_item, index)`, `data: (from, to, amount, true)`) and
  one `bt_done` summary (`data: (from, token, count, total)`).
- Gas benchmark: `batch_transfer_test::test_batch_transfer_gas_benchmark` prints CPU/memory cost.
