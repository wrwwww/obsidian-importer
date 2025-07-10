export interface Meta {
	book: Book;
	docs: Doc[];
	version: string;
}

export interface Book {
	public: number;
	type: string;
	path: string;
	tocYml: string;
}

export interface Doc {
	body_html: string;
	content_updated_at: string;
	body: string;
	body_asl: string;
	body_draft: string;
	body_draft_asl: string;
	slug: string;
	type: string;
	book_id: number;
	user_id: number;
	title: string;
	cover: string;
	custom_cover: string;
	description: string;
	format: string;
	status: number;
	read_status: number;
	view_status: number;
	public: number;
	comments_count: number;
	likes_count: number;
	collaboration_count: number;
	last_editor_id: number;
	draft_version: number;
	word_count: number;
	created_at: string;
	updated_at: string;
	published_at: string;
	first_published_at: string;
	id: number;
}
