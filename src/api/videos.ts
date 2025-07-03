import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { readableStreamToText, type BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { randomBytes } from "node:crypto";
import path from "node:path";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();

  const videoData = formData.get("video");

  if (!(videoData instanceof File)) {
    throw new BadRequestError("Video is not a file");
  }

  const MAX_UPLOAD_SIZE = 1 << 30; // 1GB

  if (videoData.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video is larger than 1GB");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Video not found");
  }

  if (video.userID != userID) {
    throw new UserForbiddenError("Wrong user");
  }

  if (videoData.type !== "video/mp4") {
    throw new BadRequestError("Unsupported video format");
  }

  const extension = videoData.type.split("/").at(-1);
  const data = await videoData.arrayBuffer();
  const fileName = `${randomBytes(32).toString("base64url")}.${extension}`;

  const targetPath = path.join(cfg.assetsRoot, fileName);

  await Bun.write(targetPath, data);
  const prefix = await getVideoAspectRatio(targetPath);
  const processedFilePath = await processVideoForFastStart(targetPath);
  await Bun.file(targetPath).delete();
  const localFile = Bun.file(processedFilePath);
  const key = `${prefix}/${fileName}`;
  const s3File = cfg.s3Client.file(key);
  await s3File.write(localFile);
  await localFile.delete();

  video.videoURL = key;

  updateVideo(cfg.db, video);

  const signedVideo = dbVideoToSignedVideo(cfg, video);

  return respondWithJSON(200, signedVideo);
}

function generatePresignedURL(cfg: ApiConfig, key: string, expireTime: number = 3600) {
  return cfg.s3Client.presign(key, { expiresIn: expireTime });
}

export function dbVideoToSignedVideo(cfg: ApiConfig, video: Video) {
  if (!video.videoURL) {
    return video;
  }

  video.videoURL = generatePresignedURL(cfg, video.videoURL);
  return video;
}

async function getVideoAspectRatio(filePath: string) {
  const subprocess = Bun.spawn({
    cmd: ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath],
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await readableStreamToText(subprocess.stdout);

  if (await subprocess.exited !== 0) {
    throw new Error(`Failed to read dimensions of ${filePath}: \n${await readableStreamToText(subprocess.stderr)}`)
  }

  const obj = JSON.parse(text).streams[0];
  const aspectRatio = obj.width / obj.height;

  if (Math.abs(aspectRatio - 16 / 9) < 0.01) {
    return "landscape";
  }

  if (Math.abs(aspectRatio - 9 / 16) < 0.01) {
    return "portrait";
  }

  return "other";
}

async function processVideoForFastStart(filePath: string) {
  const outputFilePath = `${filePath}.processed`;

  const subprocess = Bun.spawn({
    cmd: ["ffmpeg", "-i", filePath, "-movflags", "faststart", "-map_metadata", "0", "-codec", "copy", "-f", "mp4", outputFilePath],
    stdout: "pipe",
    stderr: "pipe",
  });

  if (await subprocess.exited !== 0) {
    throw new Error(`Failed to process video for fast start ${filePath}: \n${await readableStreamToText(subprocess.stderr)}`)
  }

  return outputFilePath;
}