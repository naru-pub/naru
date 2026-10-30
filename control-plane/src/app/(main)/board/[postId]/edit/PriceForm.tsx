"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MARKET_FEE_PERCENT,
  MAX_TEMPLATE_PRICE,
  MIN_TEMPLATE_PRICE,
  isTemplatePrice,
  sellerShare,
  won,
} from "@/lib/market/constants";
import { boardRequest } from "../../_components/api";

// The template's price: free, or what buyers pay through Toss. Selling
// takes the author's payout details first (/account/market).
export function PriceForm({
  templateId,
  price,
  canSell,
}: {
  templateId: string;
  price: number;
  canSell: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(price ? String(price) : "0");
  const [busy, setBusy] = useState(false);
  const amount = Number(value);
  const valid = value.trim() !== "" && isTemplatePrice(amount);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await boardRequest(`/api/board/templates/${templateId}/price`, "PUT", {
        price: amount,
      });
      toast.success(
        amount ? `${won(amount)}으로 정했어요.` : "무료로 바꿨어요.",
      );
      router.refresh();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {!canSell && (
        <p className="border border-border bg-secondary p-3 text-xs">
          유료로 팔려면 먼저{" "}
          <Link href="/account/market" className="text-primary underline">
            판매자 정산 정보
          </Link>
          를 등록해 주세요.
        </p>
      )}
      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_TEMPLATE_PRICE}
          step={100}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label="가격 (원)"
          className="w-40"
          disabled={!canSell && price === 0}
        />
        <span className="text-sm">원</span>
        <Button type="submit" disabled={busy || !valid || amount === price}>
          {busy ? "저장 중…" : "저장"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        0원이면 무료예요. 유료는 {won(MIN_TEMPLATE_PRICE)}부터{" "}
        {won(MAX_TEMPLATE_PRICE)}까지 100원 단위로 정해요.
        {valid && amount > 0 && (
          <>
            {" "}
            팔릴 때마다 수수료 {MARKET_FEE_PERCENT}%를 뺀{" "}
            <strong>{won(sellerShare(amount))}</strong>을 정산해요.
          </>
        )}
      </p>
    </form>
  );
}
