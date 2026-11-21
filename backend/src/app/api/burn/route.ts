import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { stellarService } from "@/services/stellar-service-integration";

const burnRequestSchema = z.object({
  publicKey: z.string().min(1, "publicKey is required"),
  amount: z
    .union([z.string(), z.number()])
    .transform((value) => String(value))
    .refine((value) => Number(value) > 0, "amount must be greater than 0"),
  assetCode: z.string().min(1).optional(),
  assetIssuer: z.string().min(1).optional(),
});

export async function POST(request: NextRequest) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = burnRequestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  const { publicKey, amount, assetCode, assetIssuer } = parsed.data;

  try {
    const result = await stellarService.burnTokens({
      publicKey,
      amount,
      assetCode,
      assetIssuer,
    });

    return NextResponse.json(
      {
        success: true,
        data: result,
      },
      { status: 200 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to burn tokens",
      },
      { status: 500 },
    );
  }
}
