import os, re, tempfile
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
import requests as http_requests

load_dotenv()

# Models are loaded lazily (on first request) so the server starts fast
embedding_model = None
model = None
splitter = None
template = None

def get_models():
    global embedding_model, model, splitter, template
    if embedding_model is None:
        from langchain_huggingface import ChatHuggingFace, HuggingFaceEndpoint, HuggingFaceEndpointEmbeddings
        from langchain_text_splitters import RecursiveCharacterTextSplitter
        from langchain_core.prompts import PromptTemplate
        
        print("Loading embedding model...")
        embedding_model = HuggingFaceEndpointEmbeddings(
            model="sentence-transformers/all-MiniLM-L6-v2",
            huggingfacehub_api_token=os.getenv("HUGGINGFACEHUB_API_TOKEN")
        )
        print("Loading LLM...")
        llm = HuggingFaceEndpoint(
            repo_id="Qwen/Qwen2.5-72B-Instruct",
            task="text-generation",
            temperature=0.1,
            huggingfacehub_api_token=os.getenv("HUGGINGFACEHUB_API_TOKEN")
        )
        model = ChatHuggingFace(llm=llm)
        
        splitter = RecursiveCharacterTextSplitter(
            separators=["\n\n", "\n", ".", " "],
            chunk_size=1000, chunk_overlap=200, length_function=len
        )

        template = PromptTemplate(
            template="""You are a knowledgeable expert. You have notes from multiple videos, each labeled (e.g. [Video 1], [Video 2]).

{context}

When the user refers to "first video", "second video", etc., use ONLY that video's information.
Answer directly and confidently. Never say "not mentioned" or "not explicitly stated". Just answer clearly.

Question: {Question}

Answer:""",
            input_variables=["context", "Question"]
        )
        print("Models ready!")
    return embedding_model, model, splitter, template

# State
vector_store = None
loaded_videos = []


# Helper: extract video ID from URL
def extract_video_id(text):
    text = text.strip()
    for pattern in [r'youtube\.com/watch\?v=([a-zA-Z0-9_-]{11})', r'youtu\.be/([a-zA-Z0-9_-]{11})',
                    r'youtube\.com/embed/([a-zA-Z0-9_-]{11})', r'youtube\.com/shorts/([a-zA-Z0-9_-]{11})']:
        match = re.search(pattern, text)
        if match:
            return match.group(1)
    return text


# Helper: get video title
def get_video_title(video_id):
    try:
        resp = http_requests.get(f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json", timeout=5)
        if resp.status_code == 200:
            return resp.json().get("title", video_id)
    except Exception:
        pass
    return video_id


# Helper: fetch transcript and build FAISS store
def fetch_video_store(video_id, video_number):
    from youtube_transcript_api import YouTubeTranscriptApi
    from langchain_community.vectorstores import FAISS

    ytt_api = YouTubeTranscriptApi()
    languages_to_try = [["en"], ["hi"], ["en", "hi"]]
    
    last_error = "Unknown error"

    def try_fetch(fn):
        nonlocal last_error
        for langs in languages_to_try:
            try:
                return fn(langs)
            except Exception as e:
                last_error = str(e)
                continue
        try:
            available = ytt_api.list(video_id)
            if available:
                return fn([available[0].language_code])
        except Exception as e:
            last_error = str(e)
            pass
        return None

    # 1. Try with a manually uploaded cookies.txt file
    transcript = None
    cookies_file = os.path.join(BASE_DIR, "cookies.txt")
    if not os.path.exists(cookies_file):
        cookies_file = os.path.join(BASE_DIR, "cookiew.txt")
        
    if os.path.exists(cookies_file):
        transcript = try_fetch(lambda langs: ytt_api.fetch(video_id, languages=langs, cookies=cookies_file))

    # Fallback without cookies
    if not transcript:
        transcript = try_fetch(lambda langs: ytt_api.fetch(video_id, languages=langs))

    if not transcript:
        raise Exception(f"Failed to fetch transcript: {last_error}")

    emb, _, splitter, _ = get_models()
    text = " ".join(s.text for s in transcript)
    docs = splitter.create_documents([text], metadatas=[{"video_number": video_number, "video_id": video_id}])
    store = FAISS.from_documents(documents=docs, embedding=emb)
    return store, len(docs)


# Request models
class LoadVideoRequest(BaseModel):
    video_id: str
    retain: bool = False

class ChatRequest(BaseModel):
    query: str


# FastAPI app
app = FastAPI(title="VidChat AI")


@app.post("/api/load_video")
async def load_video(req: LoadVideoRequest):
    global vector_store, loaded_videos
    video_id = extract_video_id(req.video_id)
    if not video_id:
        raise HTTPException(400, "Video ID is required")

    try:
        video_number = len(loaded_videos) + 1 if (req.retain and vector_store) else 1
        new_store, chunks = fetch_video_store(video_id, video_number)

        if req.retain and vector_store:
            vector_store.merge_from(new_store)
        else:
            vector_store = new_store
            loaded_videos = []

        title = get_video_title(video_id)
        loaded_videos.append({"id": video_id, "title": title, "number": video_number})

        return {"success": True, "video_id": video_id, "title": title, "chunks": chunks,
                "total_videos": len(loaded_videos), "loaded_videos": loaded_videos,
                "retained": req.retain and len(loaded_videos) > 1}
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/chat")
async def chat(req: ChatRequest):
    query = req.query.strip()
    if not query:
        raise HTTPException(400, "Query is required")
    if not vector_store:
        return {"error": "No video loaded. Please load a video first."}

    try:
        _, chat_model, _, tmpl = get_models()
        results = vector_store.as_retriever(search_kwargs={"k": 6}).invoke(query)
        context = "\n\n".join(
            f"[Video {r.metadata.get('video_number', '?')} \u2014 {r.metadata.get('video_id', '')}]:\n{r.page_content}"
            for r in results
        ) if results else ""

        prompt = tmpl.invoke({"context": context, "Question": query})

        for attempt in range(2):
            try:
                _, llm_model = get_models()
                answer = llm_model.invoke(prompt)
                return {"answer": answer.content}
            except Exception:
                if attempt == 0:
                    continue
                return {"answer": "Sorry, couldn't generate a response. Try rephrasing."}
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/status")
async def status():
    return {"has_video": vector_store is not None, "loaded_videos": loaded_videos}


@app.post("/api/clear")
async def clear():
    global vector_store, loaded_videos
    vector_store = None
    loaded_videos = []
    return {"success": True}


# Serve frontend (from root directory, since static folder was removed)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

@app.get("/")
async def serve_index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

@app.get("/style.css")
async def serve_css():
    return FileResponse(os.path.join(STATIC_DIR, "style.css"))

@app.get("/script.js")
async def serve_js():
    return FileResponse(os.path.join(STATIC_DIR, "script.js"))

@app.get("/favicon.svg")
async def serve_favicon():
    return FileResponse(os.path.join(STATIC_DIR, "favicon.svg"))

if __name__ == "__main__":
    import uvicorn
    # Use PORT environment variable for Render, default to 5000 locally
    port = int(os.environ.get("PORT", 5000))
    print(f"\n Server: http://0.0.0.0:{port}")
    # Must bind to 0.0.0.0 for cloud providers to detect it
    uvicorn.run(app, host="0.0.0.0", port=port)
