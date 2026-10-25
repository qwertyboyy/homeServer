import { Suspense } from "react";
import { Card, LoadingRows } from "@/components/ui";
import { AppDetail } from "./AppDetail";

// The app id is only known at request time; with cacheComponents, useParams()
// inside AppDetail suspends during prerendering, so it needs this boundary.
export default function HostedAppPage() {
  return (
    <Suspense
      fallback={
        <Card>
          <LoadingRows rows={5} />
        </Card>
      }
    >
      <AppDetail />
    </Suspense>
  );
}
