# Vesting Cliff + Linear Schedules (#2236)

Module: `vesting_schedule.rs`. Entry points: `create_vesting_schedule`, `claim_vesting_schedule`,
`get_vesting_schedule`, `get_vested_amount`, `get_claimable_amount`.

Parameters: `amount > 0`, `duration > 0`, `cliff_duration <= duration`, `start_time + duration` must not overflow
(otherwise `InvalidAmount` / `InvalidVestingSchedule`=420). Unknown id -> `VestingScheduleNotFound`=421.

Formulas (`cliff = start + cliff_duration`, `end = start + duration`):

- `now < cliff`: vested = 0
- `now >= end`: vested = total
- else: vested = floor(total * (now - start) / duration)
- claimable = vested - claimed

Claims before the cliff return `CliffNotReached`; a claim with nothing new returns `NothingToClaim`.
Tokens are escrowed in the contract on creation. Events: `vs_new`, `vs_claim`.
