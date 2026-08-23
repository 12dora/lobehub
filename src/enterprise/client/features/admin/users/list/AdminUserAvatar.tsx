'use client';

import { Avatar } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { memo, useEffect, useState } from 'react';

/**
 * Stop waiting on a provider CDN that has not answered by then. The request is dropped and the
 * name fallback stays, so one unreachable host cannot keep a row half-rendered for a minute.
 */
const IMAGE_TIMEOUT_MS = 8000;

const styles = createStaticStyles(({ css }) => ({
  image: css`
    position: absolute;
    inset: 0;

    border-radius: 50%;

    object-fit: cover;

    transition: opacity 120ms ease-in;
  `,
  root: css`
    position: relative;
    flex: none;
  `,
}));

export interface AdminUserAvatarProps {
  avatar?: string | null;
  /** Display name — drives the fallback glyph and the accessible label. */
  name: string;
  size?: number;
}

/**
 * SSO avatars are raw provider URLs (a DingTalk CDN, for example) that can answer slowly or never.
 * `@lobehub/ui`'s Avatar only swaps to its fallback in `onError`, which leaves the cell blank until
 * the browser's own network timeout — so paint the name fallback immediately and reveal the remote
 * image only once it has actually decoded.
 */
const AdminUserAvatar = memo<AdminUserAvatarProps>(({ avatar, name, size = 32 }) => {
  const [loaded, setLoaded] = useState(false);
  const [abandoned, setAbandoned] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setAbandoned(false);
  }, [avatar]);

  useEffect(() => {
    if (!avatar || loaded || abandoned) return;
    const timer = setTimeout(() => setAbandoned(true), IMAGE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [avatar, loaded, abandoned]);

  return (
    <div className={styles.root} style={{ blockSize: size, inlineSize: size }}>
      <Avatar avatar={name} size={size} title={name} />
      {avatar && !abandoned ? (
        <img
          alt={name}
          className={styles.image}
          height={size}
          loading={'lazy'}
          src={avatar}
          style={{ opacity: loaded ? 1 : 0 }}
          width={size}
          onError={() => setAbandoned(true)}
          onLoad={() => setLoaded(true)}
        />
      ) : null}
    </div>
  );
});

AdminUserAvatar.displayName = 'AdminUserAvatar';

export default AdminUserAvatar;
