import * as fs from 'fs';
import * as path from 'path';

export const AUTO_COMMENT_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const AUTO_COMMENT_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

export function isManagedAutoCommentImagePath(filePath: string, imageDir: string): boolean {
  const relative = path.relative(path.resolve(imageDir), path.resolve(filePath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function validateAutoCommentImageContent(header: Buffer): string | null {
  const isJpeg = header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const isPng = header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const signature = header.subarray(0, 6).toString('ascii');
  const isGif = signature === 'GIF87a' || signature === 'GIF89a';
  const isWebp = header.length >= 12
    && header.subarray(0, 4).toString('ascii') === 'RIFF'
    && header.subarray(8, 12).toString('ascii') === 'WEBP';
  return isJpeg || isPng || isGif || isWebp ? null : 'Nội dung tệp không phải ảnh JPEG, PNG, GIF hoặc WebP';
}

export function validateAutoCommentImage(filePath: string, size: number): string | null {
  if (!AUTO_COMMENT_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return 'Ảnh phải thuộc định dạng JPEG, PNG, GIF hoặc WebP';
  }
  if (size > AUTO_COMMENT_IMAGE_MAX_BYTES) return 'Ảnh không được vượt quá 25 MiB';
  return null;
}

export async function validateAutoCommentImageFile(
  filePath: string,
  imageDir?: string,
): Promise<string | null> {
  if (imageDir && !isManagedAutoCommentImagePath(filePath, imageDir)) return 'Ảnh nằm ngoài thư mục được quản lý';
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) return 'Tệp ảnh không hợp lệ';
  const basicError = validateAutoCommentImage(filePath, stat.size);
  if (basicError) return basicError;
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return validateAutoCommentImageContent(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

