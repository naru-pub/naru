"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { Trash2, Loader } from "lucide-react";
import { toast } from "sonner";

// app: on /app/account/delete, which stays put once the account is gone
// instead of going to the site's front page.
export default function DeleteAccountButton({ app = false }: { app?: boolean }) {
  const [isLoading, setIsLoading] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);
  const [password, setPassword] = useState("");

  const handleDeleteAccount = async () => {
    if (!password) {
      toast.error("비밀번호를 입력해주세요.");
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch("/api/account/request-account-deletion", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      });

      const result = await response.json();

      if (result.success && result.requiresImmediateConfirmation) {
        // User has no verified email - proceed with immediate deletion
        const deleteResponse = await fetch(
          "/api/account/delete-account-immediately",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ password }),
          }
        );

        const deleteResult = await deleteResponse.json();
        if (deleteResult.success) {
          toast.success(deleteResult.message);
          if (app) setDeleted(true);
          else window.location.href = "/";
        } else {
          toast.error(deleteResult.message);
        }
      } else if (result.success) {
        // User has verified email - email confirmation sent
        toast.success(result.message);
        setShowPasswordConfirm(false);
        setPassword("");
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      toast.error("계정 삭제 요청 중 오류가 발생했습니다.");
    } finally {
      setIsLoading(false);
    }
  };

  if (deleted)
    return (
      <p role="status" className="font-medium">
        계정을 삭제했습니다. 나루 앱으로 돌아가 주세요.
      </p>
    );

  if (showPasswordConfirm) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive font-medium">
          계정을 삭제하려면 비밀번호를 입력해주세요.
        </p>
        <Input
          type="password"
          placeholder="비밀번호"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleDeleteAccount();
          }}
          disabled={isLoading}
        />
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={isLoading}
            onClick={() => {
              setShowPasswordConfirm(false);
              setPassword("");
            }}
          >
            취소
          </Button>
          <Button
            variant="destructive"
            disabled={isLoading || !password}
            onClick={handleDeleteAccount}
            className="flex items-center gap-2"
          >
            {isLoading ? (
              <>
                <Loader size={16} className="animate-spin" />
                처리 중...
              </>
            ) : (
              <>
                <Trash2 size={16} />
                계정 삭제
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Button
      variant="destructive"
      onClick={() => setShowPasswordConfirm(true)}
      className="flex items-center gap-2"
    >
      <Trash2 size={16} />
      계정 삭제
    </Button>
  );
}
