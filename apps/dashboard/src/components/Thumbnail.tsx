import { useEffect, useRef, useState } from 'react';
import { usePreviewRenderer } from '../preview/PreviewContext';
import { MAX_THUMBNAIL_PX } from '../preview/types';
import { strings } from '../strings';
import styles from './Thumbnail.module.css';

type RenderState = 'waiting' | 'loading' | 'done' | 'error';

/** Lazily renders a page thumbnail once it scrolls into view. */
export function Thumbnail({ jobId, pageIndex }: { jobId: string; pageIndex: number }) {
  const renderer = usePreviewRenderer();
  const figureRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const [state, setState] = useState<RenderState>('waiting');
  const pageNumber = pageIndex + 1;

  useEffect(() => {
    if (visible || !figureRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(figureRef.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setState('loading');
    renderer.render({ jobId, pageIndex, maxPx: MAX_THUMBNAIL_PX }).then(
      (image) => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = image.width;
          canvas.height = image.height;
          canvas.getContext('2d')?.drawImage(image.source, 0, 0);
        }
        setState('done');
      },
      () => {
        if (!cancelled) setState('error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [visible, renderer, jobId, pageIndex]);

  return (
    <figure ref={figureRef} className={styles.figure} data-state={state}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        role="img"
        aria-label={strings.jobDetail.screenPreviewOf(pageNumber)}
        hidden={state !== 'done'}
      />
      {state === 'loading' && <span className={styles.placeholder}>{strings.jobDetail.previewLoading}</span>}
      {state === 'error' && <span className={styles.placeholder}>{strings.jobDetail.previewFailed}</span>}
      <figcaption className={styles.caption}>
        {strings.jobDetail.screenPreview} · {strings.jobDetail.page} {pageNumber}
      </figcaption>
    </figure>
  );
}
