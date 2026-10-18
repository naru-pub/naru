import { Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  GOOGLE_PLAY_PACKAGE,
  GOOGLE_SUBSCRIPTION,
  STORE_LABELS,
  type Store,
} from "@/lib/payments/store/products";

const MANAGE_URLS: Record<Store, string> = {
  apple: "https://apps.apple.com/account/subscriptions",
  google: `https://play.google.com/store/account/subscriptions?sku=${GOOGLE_SUBSCRIPTION}&package=${GOOGLE_PLAY_PACKAGE}`,
};

// A supporter plan bought in the Naru app renews in its store, and is managed
// there: 나루 starts no Toss plan or purchase beside it.
export function StoreSubscriptionCard({
  store,
  productId,
  expiresAt,
}: {
  store: Store;
  productId: string;
  expiresAt: Date;
}) {
  const yearly = productId.includes("yearly");
  return (
    <Card className="rounded-none bg-card border-2 border-line">
      <CardHeader className="border-b border-border">
        <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
          <Smartphone size={20} />
          {STORE_LABELS[store]}에서 구독 중
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4 text-sm">
        <p className="text-muted-foreground">
          나루 앱에서 {yearly ? "연간" : "월간"} 서포터 플랜을 구독하셨습니다.
          다음 갱신일은{" "}
          <strong className="text-foreground">
            {expiresAt.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}
          </strong>
          입니다. 결제와 해지, 환불은 {STORE_LABELS[store]}에서 관리합니다.
        </p>
        <p className="text-muted-foreground">
          웹사이트에서 결제하려면 먼저 {STORE_LABELS[store]}에서 구독을 해지해
          주세요. 남은 기간이 끝난 뒤부터 결제됩니다.
        </p>
        <Button asChild variant="outline">
          <a href={MANAGE_URLS[store]} target="_blank" rel="noreferrer">
            {STORE_LABELS[store]} 구독 관리
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}
