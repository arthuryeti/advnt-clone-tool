import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { VideoCloneDetail } from "@/components/organization/video-clone-detail";

export const metadata: Metadata = { title: "Video clone" };

export default async function VideoClonePage({
  params,
}: {
  params: Promise<{ cloneId: string }>;
}) {
  const { cloneId } = await params;
  return (
    <main>
      <nav className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6">
        <Link
          className="inline-flex items-center gap-1.5 text-[#A8A8AE] text-sm transition-colors hover:text-[#F4F4F5]"
          href="/"
        >
          <ArrowLeftIcon className="size-4" />
          All clones
        </Link>
      </nav>
      <VideoCloneDetail templateId={cloneId} />
    </main>
  );
}
