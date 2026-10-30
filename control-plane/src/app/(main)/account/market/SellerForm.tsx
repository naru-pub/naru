"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { BANKS, BUSINESS_TYPE_LABELS } from "@/lib/market/constants";
import { boardRequest } from "../../board/_components/api";

type BusinessType = "INDIVIDUAL" | "INDIVIDUAL_BUSINESS" | "CORPORATE";

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function AccountFields({
  bankCode,
  setBankCode,
}: {
  bankCode: string;
  setBankCode: (code: string) => void;
}) {
  return (
    <>
      <Field id="bankCode" label="은행">
        <Select
          id="bankCode"
          name="bankCode"
          value={bankCode}
          onChange={(event) => setBankCode(event.target.value)}
          wrapperClassName="w-full"
          required
        >
          <option value="">은행 고르기</option>
          {BANKS.map((bank) => (
            <option key={bank.code} value={bank.code}>
              {bank.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="accountNumber" label="계좌번호 (숫자만)">
        <Input
          id="accountNumber"
          name="accountNumber"
          inputMode="numeric"
          autoComplete="off"
          required
        />
      </Field>
      <Field id="holderName" label="예금주">
        <Input id="holderName" name="holderName" required />
      </Field>
    </>
  );
}

// Registers the author at Toss for payouts. Everything here goes to Toss;
// 나루 keeps the name, the bank and the account's last four digits.
export function SellerRegistrationForm({ email }: { email: string }) {
  const router = useRouter();
  const [type, setType] = useState<BusinessType>("INDIVIDUAL");
  const [bankCode, setBankCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    try {
      await boardRequest("/api/market/seller", "POST", {
        ...form,
        businessType: type,
      });
      toast.success("판매자로 등록했어요.");
      router.refresh();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field id="businessType" label="사업자 유형">
        <Select
          id="businessType"
          value={type}
          onChange={(event) => setType(event.target.value as BusinessType)}
          wrapperClassName="w-full"
        >
          {Object.entries(BUSINESS_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      {type === "INDIVIDUAL" ? (
        <Field id="name" label="이름 (실명)">
          <Input id="name" name="name" autoComplete="name" required />
        </Field>
      ) : (
        <>
          <Field id="companyName" label="상호">
            <Input id="companyName" name="companyName" />
          </Field>
          <Field id="representativeName" label="대표자 이름">
            <Input id="representativeName" name="representativeName" required />
          </Field>
          <Field
            id="businessRegistrationNumber"
            label="사업자등록번호 (10자리)"
          >
            <Input
              id="businessRegistrationNumber"
              name="businessRegistrationNumber"
              inputMode="numeric"
              required
            />
          </Field>
        </>
      )}
      <Field id="email" label="이메일">
        <Input
          id="email"
          name="email"
          type="email"
          defaultValue={email}
          required
        />
      </Field>
      <Field id="phone" label="휴대전화 (숫자만)">
        <Input
          id="phone"
          name="phone"
          inputMode="tel"
          autoComplete="tel"
          required
        />
      </Field>
      <AccountFields bankCode={bankCode} setBankCode={setBankCode} />
      <div className="space-y-2 sm:col-span-2">
        <p className="text-xs text-muted-foreground">
          정산은 토스페이먼츠 지급대행으로 이루어져요. 입력한 정보는
          토스페이먼츠로 보내고, 나루에는 이름과 은행, 계좌번호 끝 네 자리만
          남겨요.
          {type === "INDIVIDUAL" &&
            " 개인은 등록한 뒤 토스페이먼츠가 보내는 안내로 본인 인증을 마쳐야 정산받을 수 있어요."}
        </p>
        <Button type="submit" disabled={busy || !bankCode}>
          {busy ? "등록 중…" : "판매자로 등록"}
        </Button>
      </div>
    </form>
  );
}

export function SellerAccountForm() {
  const router = useRouter();
  const [bankCode, setBankCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    try {
      await boardRequest("/api/market/seller/account", "PUT", form);
      toast.success("정산 계좌를 바꿨어요.");
      router.refresh();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3">
      <AccountFields bankCode={bankCode} setBankCode={setBankCode} />
      <div className="sm:col-span-3">
        <Button type="submit" variant="outline" disabled={busy || !bankCode}>
          {busy ? "바꾸는 중…" : "계좌 바꾸기"}
        </Button>
      </div>
    </form>
  );
}

export function SyncSellerButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await boardRequest("/api/market/seller/sync", "POST");
          router.refresh();
        } catch (error: any) {
          toast.error(error.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "확인 중…" : "상태 다시 확인"}
    </Button>
  );
}

export function RefundTemplateButton({ purchaseId }: { purchaseId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        const ok = await confirm({
          title: "이 템플릿 구매를 환불할까요?",
          description:
            "카드 결제를 취소하고, 이 템플릿은 다시 사야 적용할 수 있어요.",
          confirmText: "환불",
          destructive: true,
        });
        if (!ok) return;
        setBusy(true);
        try {
          const result = await boardRequest<{ message: string }>(
            `/api/market/purchases/${purchaseId}/refund`,
            "POST",
          );
          toast.success(result.message);
          router.refresh();
        } catch (error: any) {
          toast.error(error.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "요청 중…" : "환불"}
    </Button>
  );
}
