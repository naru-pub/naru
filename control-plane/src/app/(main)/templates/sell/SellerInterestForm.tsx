"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_SELLER_INTEREST_LENGTH,
  SELLER_INTEREST_PRICES,
  type SellerInterestPrice,
} from "@/lib/board/seller-interest-options";
import { boardRequest } from "../../board/_components/api";

export function SellerInterestForm({
  initial,
}: {
  initial: { description: string; priceRange: SellerInterestPrice } | null;
}) {
  const [description, setDescription] = useState(initial?.description ?? "");
  const [priceRange, setPriceRange] = useState<SellerInterestPrice | "">(
    initial?.priceRange ?? "",
  );
  const [saved, setSaved] = useState(initial !== null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await boardRequest("/api/board/seller-interest", "PUT", {
        description,
        priceRange,
      });
      setSaved(true);
      toast.success("알려 주셔서 고마워요!");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-5 border-2 border-line bg-card p-5"
    >
      <div className="space-y-2">
        <Label htmlFor="seller-interest-description">
          어떤 템플릿을 판매하고 싶나요?
        </Label>
        <Textarea
          id="seller-interest-description"
          required
          rows={5}
          maxLength={MAX_SELLER_INTEREST_LENGTH}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="만들었거나 만들고 싶은 템플릿, 누구에게 필요할지 적어 주세요."
        />
      </div>
      <div className="flex flex-col items-start gap-2">
        <Label htmlFor="seller-interest-price">
          템플릿의 판매 가격대는 어떻게 되나요?
        </Label>
        <Select
          id="seller-interest-price"
          required
          value={priceRange}
          onChange={(event) =>
            setPriceRange(event.target.value as SellerInterestPrice)
          }
        >
          <option value="" disabled>
            골라 주세요
          </option>
          {Object.entries(SELLER_INTEREST_PRICES).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saved ? "고쳐서 보내기" : "관심 알리기"}
        </Button>
        {saved && (
          <p className="text-sm text-muted-foreground">
            받았어요. 고치고 싶으면 다시 보내 주세요.
          </p>
        )}
      </div>
    </form>
  );
}
