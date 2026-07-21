import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import { getGlobalPromo } from "../utils/globalPromoCache";
import { computeEffectivePremium } from "../utils/premium";

// ── Payment gateway config ─────────────────────────────────────────
const PAYMENT_GATEWAY_URL = process.env.PAYMENT_GATEWAY_URL;
const PUBLIC_API_URL = process.env.PUBLIC_API_URL;

async function getActivePlans(db: any) {
  const count = await db.collection("subscription_plans").countDocuments();

  return db
    .collection("subscription_plans")
    .find({ isActive: { $ne: false } })
    .sort({ order: 1 })
    .toArray();
}

async function getPlanByPlanId(planId: string, db: any) {
  const plans = await getActivePlans(db);
  return plans.find((p: any) => p.planId === planId) || null;
}

// ── POST /api/subscription/order ──────────────────────────────────
export const createSubscriptionOrder = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { planId } = req.body;

    const db = mongoose.connection.db;
    const plan = await getPlanByPlanId(planId, db);
    if (!plan) {
      return res.status(400).json({ success: false, message: "Invalid plan" });
    }

    const orderId = crypto.randomBytes(12).toString("hex");

    // ─────────────────────────────────────────────────────────
    // 🧪 TEST MODE — for testing only, remove this block before production
    // ─────────────────────────────────────────────────────────
    const TEST_MODE = true;

    if (TEST_MODE) {
      await db.collection("subscription_orders").insertOne({
        orderId,
        userId,
        planId: plan.planId,
        planTitle: plan.title,
        days: plan.days,
        amount: plan.price,
        status: "paid",
        createdAt: new Date(),
        paidAt: new Date(),
        testMode: true,
      });

      await _extendUserSubscription(userId, plan.planId, plan.days, db);

      return res.json({
        success: true,
        data: {
          orderId,
          paymentUrl: null,
          testMode: true,
          amount: plan.price,
          plan: plan.title,
        },
      });
    }
    // ─────────────────────────────────────────────────────────
    // end of test block
    // ─────────────────────────────────────────────────────────

    await db.collection("subscription_orders").insertOne({
      orderId,
      userId,
      planId: plan.planId,
      planTitle: plan.title,
      days: plan.days,
      amount: plan.price,
      status: "pending",
      createdAt: new Date(),
    });

    const callbackUrl = `${PUBLIC_API_URL}/subscription/callback?orderId=${orderId}`;
    const paymentUrl =
      `${PAYMENT_GATEWAY_URL}?orderId=${orderId}` +
      `&amount=${plan.price}` +
      `&callback=${encodeURIComponent(callbackUrl)}`;

    res.json({
      success: true,
      data: { orderId, paymentUrl, amount: plan.price, plan: plan.title },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/subscription/callback ────────────────────────────────
export const subscriptionCallback = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { orderId, status } = req.query as {
      orderId?: string;
      status?: string;
    };
    const db = mongoose.connection.db;

    const order = await db
      .collection("subscription_orders")
      .findOne({ orderId });
    if (!order)
      return res.status(404).send(_resultPage(false, "Order not found"));

    if (order.status === "paid") {
      return res.send(
        _resultPage(true, "This payment has already been confirmed"),
      );
    }

    const isSuccess = status === "success" || status === "OK" || status === "1";
    if (!isSuccess) {
      await db
        .collection("subscription_orders")
        .updateOne(
          { orderId },
          { $set: { status: "failed", failedAt: new Date() } },
        );
      return res.send(_resultPage(false, "Payment failed"));
    }

    // TODO: add real transaction verification with your gateway here

    await db
      .collection("subscription_orders")
      .updateOne({ orderId }, { $set: { status: "paid", paidAt: new Date() } });

    await _extendUserSubscription(order.userId, order.planId, order.days, db);

    res.send(
      _resultPage(true, "Your subscription has been activated successfully 🎉"),
    );
  } catch (error) {
    next(error);
  }
};

async function _extendUserSubscription(
  userId: string,
  planId: string,
  days: number,
  db: any,
) {
  const now = new Date();
  const promo = await getGlobalPromo();
  const promoActive = promo.active && !!promo.endDate && promo.endDate > now;

  if (promoActive) {
    // در حین پروموشن فعال، روزهای خریداری‌شده نباید همین الان روی
    // subscriptionExpiresAt اثر بذاره — فقط به تعداد روزهای رزروشده اضافه
    // می‌شه تا موقع پایان/غیرفعال‌شدن پروموشن، یک‌جا از همون لحظه فعال بشه.
    await db
      .collection("users")
      .updateOne({ _id: new mongoose.Types.ObjectId(userId) }, [
        {
          $set: {
            subscriptionPlan: planId,
            reservedDaysAfterPromo: {
              $add: [{ $ifNull: ["$reservedDaysAfterPromo", 0] }, days],
            },
          },
        },
      ]);
    return;
  }

  const user = await db
    .collection("users")
    .findOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { projection: { subscriptionExpiresAt: 1 } },
    );

  const base =
    user?.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) > now
      ? new Date(user.subscriptionExpiresAt)
      : now;

  const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

  await db
    .collection("users")
    .updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { $set: { subscriptionPlan: planId, subscriptionExpiresAt: newExpiry } },
    );
}
function _resultPage(success: boolean, message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
  <title>Payment Result</title>
  <style>
    body{font-family:sans-serif;background:#09090b;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    .box{text-align:center;padding:32px;border-radius:20px;background:#18181b;border:1px solid #27272a}
    .icon{font-size:48px;margin-bottom:12px}
    .ok{color:#22c55e}.fail{color:#ef4444}
    p{color:#a1a1aa}
  </style></head><body>
    <div class="box">
      <div class="icon ${success ? "ok" : "fail"}">${success ? "✓" : "✕"}</div>
      <h2>${success ? "Payment Successful" : "Payment Failed"}</h2>
      <p>${message}</p>
      <p style="font-size:13px;margin-top:16px">You can now return to the app.</p>
    </div>
  </body></html>`;
}

// ── GET /api/subscription/order/:orderId/status ───────────────────
export const getOrderStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { orderId } = req.params;
    const db = mongoose.connection.db;

    const order = await db
      .collection("subscription_orders")
      .findOne({ orderId, userId });

    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    res.json({
      success: true,
      data: {
        orderId: order.orderId,
        status: order.status,
        planId: order.planId,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/subscription/status ───────────────────────────────────
export const getSubscriptionStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = (req as any).user;
    const promo = (req as any).globalPromo || (await getGlobalPromo());

    const { isPremium, effectiveExpiresAt, promoActive } =
      computeEffectivePremium(
        user?.subscriptionExpiresAt,
        promo,
        user?.reservedDaysAfterPromo,
      );

    res.json({
      success: true,
      data: {
        isPremium,
        subscriptionPlan: user?.subscriptionPlan ?? null,
        subscriptionExpiresAt: effectiveExpiresAt,
        globalPromoEndDate: promoActive ? promo.endDate : null,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/subscription/plans ─────────────────────────────────────
export const getPlans = async (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const db = mongoose.connection.db;
    const plans = await getActivePlans(db);
    res.json({
      success: true,
      data: plans.map((p: any) => ({
        id: p.planId,
        title: p.title,
        days: p.days,
        price: p.price,
      })),
    });
  } catch (error) {
    next(error);
  }
};
