import expiredInvoice from "../../../fixtures/expired-invoice.json";
import failedPayment from "../../../fixtures/failed-payment.json";
import feeTooLow from "../../../fixtures/fee-too-low.json";
import insufficientLiquidity from "../../../fixtures/insufficient-liquidity.json";
import mppNeeded from "../../../fixtures/mpp-needed.json";
import payableRoute from "../../../fixtures/payable-route.json";
import type { FixtureScenario } from "@fiber-preflight/core";

export const demoScenarios = [
  payableRoute,
  expiredInvoice,
  insufficientLiquidity,
  mppNeeded,
  feeTooLow,
  failedPayment
] as FixtureScenario[];
