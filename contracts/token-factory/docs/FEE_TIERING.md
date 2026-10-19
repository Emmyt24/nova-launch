# Fee Tiering by Feature Set (#2234)

Module: `fee_tiering.rs`. Entry points: `set_feature_fee`, `get_feature_fee`, `get_fee_tier_features`,
`quote_creation_fee`.

- Admin sets a surcharge per feature `Symbol` (e.g. `burn`, `mint`); bounds `0..=1,000 XLM`
  (`FeeTierOutOfBounds`=400); max 32 configured features and 16 per quote (`TooManyFeeTierFeatures`=401).
- Quote = `base_fee + sum(surcharge)`, duplicates charged once, checked arithmetic.
- Event `ftier_set` with `(admin, old_fee, new_fee)`.
- `create_token` is not changed by this feature; clients use `quote_creation_fee` to preview the tiered fee.
  Flat-fee behaviour is therefore unchanged.
- Gas: lookups are one instance read per feature; bounded by the 16-feature quote cap.
