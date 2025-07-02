import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";
import { randomBytes } from "crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};


export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();

  const thumbnail = formData.get("thumbnail");

  if (!(thumbnail instanceof File)) {
    throw new BadRequestError("Thumbnail is not a file");
  }

  const MAX_UPLOAD_SIZE = 10 << 20; // 10MB

  if (thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail is larger than 10MB");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Video not found");
  }

  if (video.userID != userID) {
    throw new UserForbiddenError("Wrong user");
  }

  if (thumbnail.type !== "image/png" && thumbnail.type !== "image/jpeg") {
    throw new BadRequestError("Unsupported thumbnail format");
  }

  const extension = thumbnail.type.split("/").at(-1);
  const data = await thumbnail.arrayBuffer();
  const fileName = `${randomBytes(32).toString("base64url")}.${extension}`;

  const targetPath = path.join(cfg.assetsRoot, fileName);

  await Bun.write(targetPath, data);
  video.thumbnailURL = `http://localhost:${cfg.port}/assets/${fileName}`;

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
