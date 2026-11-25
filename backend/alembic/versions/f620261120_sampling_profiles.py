"""Add private sampling profiles."""
from alembic import op
import sqlalchemy as sa

revision = 'f620261120'
down_revision = 'a3d839618e28'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'sampling_profiles',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('user_id', sa.String(36), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('configuration', sa.JSON(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_sampling_profiles_user_id', 'sampling_profiles', ['user_id'])


def downgrade():
    op.drop_table('sampling_profiles')
