import { NextResponse } from "next/server";
import {
  assertExecutionDisabled,
  TransactionExecutionDisabledError,
} from "@/lib/blockchain/execution";

export function POST() {
  try {
    assertExecutionDisabled();
  } catch (error) {
    if (error instanceof TransactionExecutionDisabledError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 403 });
    }
    throw error;
  }
}
