import { GlobalPromo } from "./globalPromoCache";

export interface EffectivePremium {
  isPremium: boolean;
  effectiveExpiresAt: Date | null;
  promoActive: boolean;
}

export function computeEffectivePremium(
  realExpiresAt: Date | string | null | undefined,
  promo: GlobalPromo,
  reservedDaysAfterPromo?: number | null,
): EffectivePremium {
  const now = new Date();
  const real = realExpiresAt ? new Date(realExpiresAt) : null;
  const promoActive = promo.active && !!promo.endDate && promo.endDate > now;

  if (promoActive) {
    const reserved =
      reservedDaysAfterPromo && reservedDaysAfterPromo > 0
        ? reservedDaysAfterPromo
        : 0;
    const effectiveExpiresAt =
      reserved > 0
        ? new Date(promo.endDate!.getTime() + reserved * 24 * 60 * 60 * 1000)
        : promo.endDate;
    return { isPremium: true, effectiveExpiresAt, promoActive: true };
  }

  const realActive = !!real && real > now;
  return { isPremium: realActive, effectiveExpiresAt: real, promoActive: false };
}