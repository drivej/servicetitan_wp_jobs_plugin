export interface WordPressPostPreview {
  id: number;
  status: string;
  titleHtml: string;
  excerptHtml: string;
  contentHtml: string;
  featuredImageUrl?: string;
  featuredImageAlt?: string;
  modifiedOn?: string;
}
