import type { ReactNode } from 'react';

interface PageHeaderProps {
  eyebrow: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  beforeTitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
  titleId?: string;
}

export function PageHeader({ eyebrow, title, description, beforeTitle, actions, className = '', titleId }: PageHeaderProps) {
  return (
    <header className={`page-header hero page-header-layout${className ? ` ${className}` : ''}`}>
      {beforeTitle}
      <p className='eyebrow'>{eyebrow}</p>
      <h1 className='page-title' id={titleId}>{title}</h1>
      {description && <p className='intro'>{description}</p>}
      {actions}
    </header>
  );
}
