import { type IconType } from '@lobehub/icons';
import { type FlexboxProps } from '@lobehub/ui';
import { Flexbox } from '@lobehub/ui';
import { type LobeChatProps } from '@lobehub/ui/brand';
import { createStaticStyles, cssVar } from 'antd-style';
import { type ReactNode } from 'react';
import { memo } from 'react';

import { type ImageProps } from '@/libs/next/Image';
import Image from '@/libs/next/Image';

const styles = createStaticStyles(({ css }) => {
  return {
    extraTitle: css`
      font-weight: 300;
      white-space: nowrap;
    `,
  };
});

const CustomTextLogo = memo<FlexboxProps & { name: string; size: number }>(
  ({ name, size, style, ...rest }) => {
    return (
      <Flexbox
        height={size}
        style={{
          fontSize: size / 1.5,
          fontWeight: 'bolder',
          userSelect: 'none',
          ...style,
        }}
        {...rest}
      >
        {name}
      </Flexbox>
    );
  },
);

const CustomImageLogo = memo<
  Omit<ImageProps, 'alt' | 'src'> & { logoUrl: string; name: string; size: number }
>(({ logoUrl, name, size, ...rest }) => {
  return <Image alt={name} height={size} src={logoUrl} unoptimized={true} width={size} {...rest} />;
});

const Divider: IconType = (({ ref, size = '1em', style, ...rest }) => (
  <svg
    fill="none"
    height={size}
    ref={ref}
    shapeRendering="geometricPrecision"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flex: 'none', lineHeight: 1, ...style }}
    viewBox="0 0 24 24"
    width={size}
    {...rest}
  >
    <path d="M16.88 3.549L7.12 20.451" />
  </svg>
)) as IconType;

interface CustomLogoProps extends LobeChatProps {
  logoUrl: string | null;
  name: string;
}

const CustomLogo = memo<CustomLogoProps>(
  ({ extra, logoUrl, name, size = 32, className, style, type, ...rest }) => {
    let logoComponent: ReactNode;

    if (!logoUrl) {
      logoComponent = <CustomTextLogo name={name} size={size} style={style} {...rest} />;
    } else {
      switch (type) {
        case '3d':
        case 'flat': {
          logoComponent = (
            <CustomImageLogo logoUrl={logoUrl} name={name} size={size} style={style} {...rest} />
          );
          break;
        }
        case 'mono': {
          logoComponent = (
            <CustomImageLogo
              logoUrl={logoUrl}
              name={name}
              size={size}
              style={{ filter: 'grayscale(100%)', ...style }}
              {...rest}
            />
          );
          break;
        }
        case 'text': {
          logoComponent = <CustomTextLogo name={name} size={size} style={style} {...rest} />;
          break;
        }
        case 'combine': {
          logoComponent = (
            <>
              <CustomImageLogo logoUrl={logoUrl} name={name} size={size} />
              <CustomTextLogo
                name={name}
                size={size}
                style={{ marginLeft: Math.round(size / 4) }}
              />
            </>
          );

          if (!extra)
            logoComponent = (
              <Flexbox horizontal align={'center'} flex={'none'} {...rest}>
                {logoComponent}
              </Flexbox>
            );

          break;
        }
        default: {
          logoComponent = (
            <CustomImageLogo logoUrl={logoUrl} name={name} size={size} style={style} {...rest} />
          );
          break;
        }
      }
    }

    if (!extra) return logoComponent;

    const extraSize = Math.round((size / 3) * 1.9);

    return (
      <Flexbox horizontal align={'center'} className={className} flex={'none'} {...rest}>
        {logoComponent}
        <Divider size={extraSize} style={{ color: cssVar.colorFill }} />
        <div className={styles.extraTitle} style={{ fontSize: extraSize }}>
          {extra}
        </div>
      </Flexbox>
    );
  },
);

export default CustomLogo;
