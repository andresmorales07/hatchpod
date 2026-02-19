.PHONY: build up down logs shell ssh mosh clean docker-test

build:
	docker compose build

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

shell:
	docker exec -it -u hatchpod hatchpod bash

ssh:
	ssh -p 2222 hatchpod@localhost

mosh:
	mosh --ssh='ssh -p 2222' hatchpod@localhost

clean:
	docker compose down -v --rmi local

docker-test:
	docker exec -u hatchpod hatchpod docker run --rm hello-world
