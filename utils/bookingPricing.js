/**
 * Single source of truth for booking price split (matches RegionPricing pre-save rounding).
 * Prevents drift like ₹75 vs ₹85 from mixing raw floats with Math.round() stored values.
 */

function computePriceComponents({
  basePrice,
  gstPercent = 18,
  platformFeePercent = 25,
  travelCharge = 0,
}) {
  const bp = Number(basePrice) || 0;
  const gp = Number(gstPercent) || 0;
  const pfp = Number(platformFeePercent) || 0;
  const tc = Number(travelCharge) || 0;

  const gstAmount = Math.round((bp * gp) / 100);
  const platformFeeAmount = Math.round((bp * pfp) / 100);
  const mechanicEarning = bp + tc;
  const companyEarning = gstAmount + platformFeeAmount;
  const totalAmount = bp + gstAmount + platformFeeAmount + tc;

  return {
    basePrice: bp,
    gstPercent: gp,
    gstAmount,
    platformFeePercent: pfp,
    platformFeeAmount,
    travelCharge: tc,
    discount: 0,
    totalAmount,
    mechanicEarning,
    companyEarning,
  };
}

/**
 * Derive booking pricing from a RegionPricing document or plain object.
 * Always recomputes GST/platform with the same rounding rules (no stale DB drift).
 */
function pricingFromRegionOrPlain(pricingInput) {
  if (!pricingInput) {
    throw new Error('pricingInput required');
  }
  const p = pricingInput.toObject ? pricingInput.toObject() : pricingInput;

  return computePriceComponents({
    basePrice: p.basePrice,
    gstPercent: p.gstPercent,
    platformFeePercent: p.platformFeePercent,
    travelCharge: p.travelCharge,
  });
}

module.exports = {
  computePriceComponents,
  pricingFromRegionOrPlain,
};
