import { getImagesBucketName } from "@/lib/env";

export const storageConfig = {
  bucketNames: {
    get images(): string {
      return getImagesBucketName();
    },
  },
};
