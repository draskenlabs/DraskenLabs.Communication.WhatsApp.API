-- A status for a subscription this product no longer answers for.
--
-- Its own migration because Postgres will not let an enum value be *used* in
-- the transaction that adds it, and the next migration collapses per-WABA
-- subscriptions onto their organisation by marking the losers with it.
--
-- It is not "cancelled": the subscription may well still be live at Razorpay,
-- and dropping our row would not stop it debiting. `superseded` says the money
-- is real and the entitlement is not ours to grant — a human reconciles it.
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'superseded';
